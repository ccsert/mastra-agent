import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { WorkflowAssetInput } from "../../packages/contracts/src/index.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";

test("SDK cursor pages preserve microseconds, scope and version ordering through concurrent changes", async (t) => {
  const schema = `test_pages_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    platform = new Platform(db, new Vault("aa".repeat(32)));
  await platform.initialize();
  const { app, workflows } = createApp(platform, {
    origin: "http://localhost",
    runtimeToken: "test",
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = createClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      throwOnError: true,
    });
    const setup = await sdk.setupPlatform({
      client,
      body: { username: "pages", password: "test-password-123", workspaceName: "Pages" },
    });
    const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    const actor = await platform.identity.session(cookie.split("=")[1]);
    const project = await platform.projects.create(actor, { name: "Pages", description: "" });
    const other = await platform.projects.create(actor, { name: "Other", description: "" });
    const path = { projectId: project.id };
    const input = WorkflowAssetInput.parse({
      name: "Synthetic",
      definition: {
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "end", type: "end", label: "End", values: {} },
        ],
        edges: [{ source: "start", target: "end", port: "out" }],
      },
    });
    await db.query(
      `INSERT INTO workflows(id,tenant_id,project_id,data,created_at)
      SELECT gen_random_uuid(),$1,$2,$3::jsonb,'2026-01-01'::timestamptz + (n/3)*interval '1 microsecond' FROM generate_series(1,127) n`,
      [actor.tenantId, project.id, input],
    );
    const expected = (
      await db.query(
        "SELECT id FROM workflows WHERE project_id=$1 ORDER BY created_at DESC,id DESC",
        [project.id],
      )
    ).map((r) => String(r.id));
    const first = await sdk.listWorkflows({ client, path, query: { limit: 13 } });
    assert.ok(Array.isArray(first.data), "legacy array response stays compatible");
    const ids = first.data.map((r) => r.id);
    let cursor = first.response?.headers.get("x-next-cursor");
    assert.ok(cursor);
    await workflows.create(actor, project.id, input); // A newer insert must not shift following pages.
    await db.query("DELETE FROM workflows WHERE id=$1", [ids.at(-1)]); // Cursor does not depend on anchor existence.
    await assert.rejects(workflows.list(actor, other.id, { cursor }), { code: "INVALID_CURSOR" });
    await assert.rejects(
      workflows.list({ ...actor, tenantId: randomUUID() }, project.id, { cursor }),
      { status: 404 },
    );
    while (cursor) {
      const page: Awaited<ReturnType<typeof sdk.listWorkflows>> = await sdk.listWorkflows({
        client,
        path,
        query: { cursor, limit: 13 },
      });
      assert.ok(page.data);
      ids.push(...page.data.map((r) => r.id));
      cursor = page.response?.headers.get("x-next-cursor");
    }
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, 127);
    for (const query of [{ cursor: "garbage" }, { limit: 0 }, { limit: 101 }]) {
      const invalid = await sdk.listWorkflows({ client, path, query, throwOnError: false });
      assert.equal(invalid.response?.status, 400);
    }
    const asset = await workflows.create(actor, project.id, input);
    const release = await workflows.publish(actor, project.id, asset.id, 1);
    await db.query(
      `INSERT INTO workflow_releases(id,tenant_id,project_id,workflow_id,name,version,digest,snapshot,created_at)
      SELECT gen_random_uuid(),tenant_id,project_id,workflow_id,name,n,digest,snapshot,created_at-interval '1 hour' FROM workflow_releases CROSS JOIN generate_series(2,105) n WHERE id=$1`,
      [release.id],
    );
    const versions: number[] = [];
    cursor = undefined;
    do {
      const page: Awaited<ReturnType<typeof sdk.listWorkflowReleases>> =
        await sdk.listWorkflowReleases({
          client,
          path: { ...path, id: asset.id },
          query: { limit: 17, cursor },
        });
      assert.ok(page.data);
      versions.push(...page.data.map((r) => r.version));
      cursor = page.response?.headers.get("x-next-cursor");
    } while (cursor);
    assert.deepEqual(
      versions,
      Array.from({ length: 105 }, (_, i) => 105 - i),
    );
    await db.query(
      `INSERT INTO workflow_jobs(id,workflow_id,tenant_id,project_id,actor_id,entry,kind,release_id,snapshot,input,request_id,request_hash,status,runtime_id,deadline)
      SELECT gen_random_uuid(),$1,$2,$3,$4,'console',kind,CASE WHEN kind='execute' THEN $5::uuid ELSE NULL END,'{}',$6::jsonb,n::text,'hash','succeeded','hosted-local',now()
      FROM generate_series(1,125) n CROSS JOIN (VALUES ('execute'),('generate')) kinds(kind)`,
      [
        asset.id,
        actor.tenantId,
        project.id,
        actor.id,
        release.id,
        { baseRevision: 1, intent: "synthetic", modelId: randomUUID() },
      ],
    );
    const queries = t.mock.method(db, "query");
    for (const list of [workflows.runs.bind(workflows), workflows.generations.bind(workflows)]) {
      const seen: string[] = [];
      let next: string | undefined;
      do {
        const before = queries.mock.callCount();
        const page = await list(actor, project.id, asset.id, { limit: 23, cursor: next });
        assert.equal(
          queries.mock.callCount() - before,
          3,
          "access + asset + one joined page; no per-item queries",
        );
        seen.push(...page.items.map((r) => r.id));
        next = page.nextCursor ?? undefined;
        if (next)
          await assert.rejects(
            list({ ...actor, id: randomUUID() }, project.id, asset.id, { cursor: next }),
            { code: "INVALID_CURSOR" },
          );
      } while (next);
      assert.equal(seen.length, 125);
      assert.equal(new Set(seen).size, 125);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
