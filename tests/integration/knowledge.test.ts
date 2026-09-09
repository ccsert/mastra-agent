import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Database } from "@platform/database";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Queue } from "../../apps/control-plane/src/modules/conversations/queue.ts";
import { Knowledge } from "../../apps/control-plane/src/modules/knowledge/knowledge.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import {
  DocumentInput,
  KnowledgeInput,
  type Principal,
} from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

test("knowledge publication, dimensions, scoped retrieval, deletion and lease fencing", async () => {
  const schema = `test_knowledge_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    store = new Platform(db, new Vault("ab".repeat(32))),
    knowledge = new Knowledge(store);
  try {
    await store.initialize();
    const ids = await store.identity.setup("owner", "test-password-123", "Knowledge");
    const actor: Principal = {
      id: ids.userId,
      tenantId: ids.tenantId,
      kind: "user",
      entry: "console",
      displayName: "Owner",
    };
    const project = await store.projects.create(actor, { name: "Knowledge", description: "" });
    const embedding = await store.resources.createModel(actor, project.id, {
      name: "Embedding",
      kind: "embedding",
      dimensions: 3,
      baseUrl: "http://localhost:9999/v1",
      modelId: "embedding",
      apiKey: "secret",
    });
    await assert.rejects(
      () =>
        store.agents.create(actor, project.id, {
          name: "Wrong model",
          instructions: "test",
          modelId: embedding.id,
          toolIds: [],
        }),
      { code: "MODEL_KIND" },
    );
    const kb = await knowledge.create(
      actor,
      project.id,
      KnowledgeInput.parse({ name: "Manual", embeddingModelId: embedding.id }),
    );
    assert.ok(!JSON.stringify(kb).includes("secret"));
    const input = DocumentInput.parse({
      filename: "manual.md",
      content: "    A5000 配备 24GB 显存。\n",
    });
    assert.equal(input.content, "    A5000 配备 24GB 显存。\n");
    const doc = await knowledge.upload(actor, project.id, kb.id, input);
    assert.equal((await knowledge.upload(actor, project.id, kb.id, input)).id, doc.id);
    await assert.rejects(() => knowledge.list({ ...actor, tenantId: randomUUID() }, project.id), {
      code: "NOT_FOUND",
    });
    const job = await knowledge.claim();
    assert.ok(job);
    assert.equal(job.credentials[embedding.id], "secret");
    await assert.rejects(
      () =>
        knowledge.batch(job.id, {
          leaseToken: job.leaseToken,
          chunks: [{ ordinal: 0, content: input.content, vector: [1, 0] }],
        }),
      { code: "DIMENSION_MISMATCH" },
    );
    const batch = {
      leaseToken: job.leaseToken,
      chunks: [{ ordinal: 0, content: input.content, vector: [1, 0, 0] }],
    };
    await knowledge.batch(job.id, batch);
    await knowledge.batch(job.id, batch);
    assert.equal((await knowledge.chunks(actor, project.id, kb.id, doc.id)).length, 0);
    await assert.rejects(
      () =>
        knowledge.batch(job.id, {
          ...batch,
          chunks: [{ ordinal: 0, content: "tampered", vector: [1, 0, 0] }],
        }),
      { code: "CHUNK_CONFLICT" },
    );
    await knowledge.finish(job.id, {
      leaseToken: job.leaseToken,
      status: "succeeded",
      chunkCount: 1,
    });
    assert.equal((await knowledge.documents(actor, project.id, kb.id)).items[0].status, "ready");
    assert.equal((await knowledge.chunks(actor, project.id, kb.id, doc.id)).length, 1);
    const chat = await store.resources.createModel(actor, project.id, {
      name: "Chat",
      baseUrl: "http://localhost:9999/v1",
      modelId: "chat",
    });
    const agent = await store.agents.create(actor, project.id, {
      name: "Knowledge agent",
      instructions: "检索资料",
      modelId: chat.id,
      toolIds: [],
      knowledgeBaseIds: [kb.id],
    });
    const release = await store.agents.publish(actor, project.id, agent.id, 1);
    assert.equal(release.snapshot.knowledgeBases[0].embeddingModel.dimensions, 3);
    const conversation = await store.conversations.create(
      actor,
      project.id,
      agent.id,
      "Pinned knowledge",
    );
    const run = await store.conversations.createRun(
      actor,
      project.id,
      conversation.id,
      "query",
      randomUUID(),
    );
    const queue = new Queue(db, store.vault, store.runtimeId),
      agentJob = await queue.claim();
    assert.ok(agentJob);
    assert.equal(agentJob.credentials.knowledgeModelKeys[embedding.id], "secret");
    const agentHits = await knowledge.queryAgent(run.id, {
      leaseToken: agentJob.leaseToken,
      knowledgeBaseId: kb.id,
      vector: [1, 0, 0],
    });
    assert.equal(agentHits.length, 1);
    await assert.rejects(
      () =>
        knowledge.queryAgent(run.id, {
          leaseToken: agentJob.leaseToken,
          knowledgeBaseId: randomUUID(),
          vector: [1, 0, 0],
        }),
      { code: "NOT_FOUND" },
    );
    await store.conversations.cancel(actor, project.id, run.id);
    await assert.rejects(
      () =>
        knowledge.queryAgent(run.id, {
          leaseToken: agentJob.leaseToken,
          knowledgeBaseId: kb.id,
          vector: [1, 0, 0],
        }),
      { code: "LEASE_EXPIRED" },
    );
    const search = await knowledge.search(actor, project.id, kb.id, {
      query: "A5000 显存",
      topK: 3,
    });
    const searchJob = await knowledge.claim();
    assert.ok(searchJob);
    const hits = await knowledge.queryJob(searchJob.id, {
      leaseToken: searchJob.leaseToken,
      knowledgeBaseId: kb.id,
      vector: [1, 0, 0],
    });
    assert.equal(hits[0].filename, "manual.md");
    assert.equal(hits[0].similarity, 1);
    await assert.rejects(
      () =>
        knowledge.queryJob(searchJob.id, {
          leaseToken: searchJob.leaseToken,
          knowledgeBaseId: randomUUID(),
          vector: [1, 0, 0],
        }),
      { code: "NOT_FOUND" },
    );
    await assert.rejects(
      () =>
        knowledge.finish(searchJob.id, {
          leaseToken: searchJob.leaseToken,
          status: "succeeded",
          results: [{ ...hits[0], id: randomUUID() }],
        }),
      { code: "INVALID_RESULTS" },
    );
    await knowledge.finish(searchJob.id, {
      leaseToken: searchJob.leaseToken,
      status: "succeeded",
      results: hits,
    });
    assert.equal(
      (await knowledge.getSearch(actor, project.id, kb.id, search.id)).results[0].content,
      input.content,
    );
    await assert.rejects(
      () => knowledge.getSearch({ ...actor, id: randomUUID() }, project.id, kb.id, search.id),
      { code: "NOT_FOUND" },
    );
    await knowledge.removeDocument(actor, project.id, kb.id, doc.id);
    assert.equal((await knowledge.chunks(actor, project.id, kb.id, doc.id)).length, 0);
    const replacement = await knowledge.upload(actor, project.id, kb.id, input);
    assert.notEqual(replacement.id, doc.id);
    const pending = await knowledge.claim();
    assert.ok(pending);
    await knowledge.removeDocument(actor, project.id, kb.id, replacement.id);
    await assert.rejects(
      () => knowledge.batch(pending.id, { ...batch, leaseToken: pending.leaseToken }),
      { code: "LEASE_EXPIRED" },
    );
    const third = await knowledge.upload(actor, project.id, kb.id, input);
    const lost = await knowledge.claim();
    assert.ok(lost);
    await db.query("UPDATE knowledge_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [
      lost.id,
    ]);
    await knowledge.reap();
    assert.equal(
      (await knowledge.documents(actor, project.id, kb.id)).items.find((d) => d.id === third.id)
        ?.status,
      "failed",
    );
    await knowledge.retry(actor, project.id, kb.id, third.id);
    const retried = await knowledge.claim();
    assert.ok(retried);
    assert.notEqual(retried.id, lost.id);
    const blocker = await db.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM knowledge_bases WHERE id=$1 FOR UPDATE", [kb.id]);
      await db.query(
        "UPDATE knowledge_jobs SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
        [retried.id],
      );
      const blockedWrite = assert.rejects(
        () => knowledge.batch(retried.id, { ...batch, leaseToken: retried.leaseToken }),
        { code: "LEASE_EXPIRED" },
      );
      await blocker.query("SELECT pg_sleep(0.3)");
      await blocker.query("COMMIT");
      await blockedWrite;
      assert.equal(
        (await db.query("SELECT id FROM knowledge_chunks WHERE job_id=$1", [retried.id])).length,
        0,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await assert.rejects(
      () =>
        knowledge.finish(lost.id, {
          leaseToken: lost.leaseToken,
          status: "succeeded",
          chunkCount: 1,
        }),
      { code: "LEASE_EXPIRED" },
    );
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
