import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { executeKnowledgeJob } from "../../apps/runtime/src/knowledge/knowledge.ts";
import { KnowledgeInput } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";
import { docxFixture, pdfFixture } from "../fixtures/knowledge-documents.ts";

test("document versions atomically switch retrieval, fence stale imports and preserve historical sources", async () => {
  const schema = `test_kb_versions_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    platform = new Platform(db, new Vault("ad".repeat(32)));
  const { app, knowledge } = createApp(platform, {
    origin: "http://console.test",
    runtimeToken: "test",
  });
  try {
    await platform.initialize();
    await platform.identity.setup("version_owner", "synthetic-password-123", "Test");
    const actor = await platform.identity.session(
      await platform.identity.login("version_owner", "synthetic-password-123"),
    );
    const project = await platform.projects.create(actor, {
      name: "Knowledge versions",
      description: "",
    });
    const model = await platform.resources.createModel(actor, project.id, {
      name: "Synthetic embedding",
      kind: "embedding",
      dimensions: 3,
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    const kb = await knowledge.create(
      actor,
      project.id,
      KnowledgeInput.parse({ name: "Manuals", embeddingModelId: model.id }),
    );
    const preview = await knowledge.previewDocument(actor, project.id, kb.id, {
      filename: "manual.pdf",
      fileBase64: pdfFixture(["A5000 memory is 24GB.", "Warranty is one year."]).toString("base64"),
    });
    assert.equal((await knowledge.documents(actor, project.id, kb.id)).items.length, 0);
    await assert.rejects(
      knowledge.importDocument({ ...actor, id: randomUUID() }, project.id, kb.id, preview.id),
    );
    const [doc, duplicate] = await Promise.all([
      knowledge.importDocument(actor, project.id, kb.id, preview.id),
      knowledge.importDocument(actor, project.id, kb.id, preview.id),
    ]);
    assert.equal(doc.id, duplicate.id);
    assert.equal(doc.version, 1);
    const index = async () => {
      const job = await knowledge.claim();
      assert.ok(job?.document?.chunks);
      const batch = {
        leaseToken: job.leaseToken,
        chunks: job.document.chunks.map((c) => ({ ...c, vector: [1, 0, 0] })),
      };
      await knowledge.batch(job.id, batch);
      await knowledge.batch(job.id, batch);
      await knowledge.finish(job.id, {
        leaseToken: job.leaseToken,
        status: "succeeded",
        chunkCount: batch.chunks.length,
      });
      return job;
    };
    await index();
    const firstHits = await knowledge.nearest(db, kb.id, [1, 0, 0]);
    assert.equal(firstHits[1].location?.kind, "page");
    const originalVersion = firstHits[0].versionId;
    const update = {
      filename: "manual.docx",
      fileBase64: docxFixture(["A5000 memory is 24GB.", "Warranty is three years."]).toString(
        "base64",
      ),
      documentId: doc.id,
    };
    const next = await knowledge.previewDocument(actor, project.id, kb.id, update),
      stale = await knowledge.previewDocument(actor, project.id, kb.id, {
        ...update,
        fileBase64: docxFixture(["Warranty is ten years."]).toString("base64"),
      });
    const second = await knowledge.importDocument(actor, project.id, kb.id, next.id);
    assert.equal(second.version, 2);
    assert.equal(second.activeVersion, 1);
    await assert.rejects(knowledge.importDocument(actor, project.id, kb.id, stale.id), {
      code: "DOCUMENT_STALE",
    });
    assert.ok(
      (await knowledge.nearest(db, kb.id, [1, 0, 0])).some((h) => h.content.includes("one year")),
    );
    const failed = await knowledge.claim();
    assert.ok(failed);
    await knowledge.finish(failed.id, {
      leaseToken: failed.leaseToken,
      status: "failed",
      errorCode: "MODEL_ERROR",
    });
    assert.equal((await knowledge.list(actor, project.id))[0].readyCount, 1);
    await knowledge.retry(actor, project.id, kb.id, doc.id);
    await index();
    const hits = await knowledge.nearest(db, kb.id, [1, 0, 0]);
    assert.ok(hits.some((h) => h.content.includes("three years")));
    assert.ok(hits.every((h) => h.version === 2));
    const historical = await knowledge.source(actor, project.id, kb.id, doc.id, originalVersion);
    assert.match(historical.sections[1].content, /one year/);
    assert.equal(historical.version.active, false);
    const unchanged = await knowledge.previewDocument(actor, project.id, kb.id, update);
    assert.equal(unchanged.unchanged, true);
    assert.equal(
      (await knowledge.importDocument(actor, project.id, kb.id, unchanged.id)).version,
      2,
    );
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        Response.json({ data: next.chunks.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
      const posts: unknown[] = [];
      await executeKnowledgeJob(
        {
          ...failed,
          id: randomUUID(),
          document: {
            id: doc.id,
            filename: next.filename,
            content: "must use reviewed chunks",
            chunks: next.chunks,
          },
        },
        AbortSignal.timeout(10000),
        async (_path, body) => {
          posts.push(body);
          return {};
        },
      );
      assert.deepEqual(
        (posts[0] as { chunks: { content: string }[] }).chunks.map((c) => c.content),
        next.chunks.map((c) => c.content),
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "version_owner", password: "synthetic-password-123" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const root = `/api/v1/projects/${project.id}/knowledge/${kb.id}`;
    assert.equal(
      (
        await app.request(`${root}/documents/${doc.id}/source?versionId=${originalVersion}`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
    const httpPreview = await app.request(`${root}/document-previews`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://console.test" },
      body: JSON.stringify({
        filename: "test.txt",
        fileBase64: Buffer.from("HTTP text").toString("base64"),
      }),
    });
    assert.equal(httpPreview.status, 200, await httpPreview.clone().text());
    const invite = await platform.members.invite(actor, {
      label: "Knowledge editor",
      projectId: project.id,
      projectRole: "editor",
    });
    await platform.members.join({
      token: invite.token,
      username: "kb_editor",
      displayName: "Editor",
      password: "synthetic-password-123",
    });
    const editor = await platform.identity.session(
      await platform.identity.login("kb_editor", "synthetic-password-123"),
    );
    const privatePreview = await knowledge.previewDocument(editor, project.id, kb.id, {
      filename: "private.txt",
      fileBase64: Buffer.from("private preview").toString("base64"),
    });
    await assert.rejects(knowledge.importDocument(actor, project.id, kb.id, privatePreview.id), {
      code: "PREVIEW_UNAVAILABLE",
    });
    const otherProject = await platform.projects.create(actor, { name: "Other", description: "" });
    await assert.rejects(knowledge.source(actor, otherProject.id, kb.id, doc.id), {
      code: "NOT_FOUND",
    });
    await platform.members.setProjectMember(actor, project.id, editor.id, "viewer");
    assert.equal((await knowledge.source(editor, project.id, kb.id, doc.id)).version.version, 2);
    await assert.rejects(knowledge.importDocument(editor, project.id, kb.id, privatePreview.id), {
      code: "FORBIDDEN",
    });
    await assert.rejects(knowledge.search(editor, project.id, kb.id, { query: "test", topK: 3 }), {
      code: "FORBIDDEN",
    });
    await platform.members.setProjectMember(actor, project.id, editor.id, null);
    await assert.rejects(knowledge.source(editor, project.id, kb.id, doc.id), {
      code: "NOT_FOUND",
    });
    await db.query(
      "UPDATE knowledge_document_previews SET expires_at=now()-interval '1 second' WHERE id=$1",
      [unchanged.id],
    );
    await assert.rejects(knowledge.importDocument(actor, project.id, kb.id, unchanged.id), {
      code: "PREVIEW_UNAVAILABLE",
    });
    await knowledge.removeDocument(actor, project.id, kb.id, doc.id);
    assert.equal((await knowledge.nearest(db, kb.id, [1, 0, 0])).length, 0);
    await assert.rejects(knowledge.source(actor, project.id, kb.id, doc.id, originalVersion), {
      code: "NOT_FOUND",
    });
    assert.ok(
      (
        await db.query(
          "SELECT original,sections FROM knowledge_document_versions WHERE document_id=$1",
          [doc.id],
        )
      ).every((v) => v.original === null && JSON.stringify(v.sections) === "[]"),
    );
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
