import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Database } from "@platform/database";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Workflows } from "../../apps/control-plane/src/modules/workflows/workflows.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { type Principal, WorkflowAssetInput } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

test("workflow lists use a constant query budget and preserve scope, draft and release metadata", async (t) => {
  const schema = `test_workflow_list_${process.pid}`,
    admin = new Database(required("DATABASE_URL")),
    db = new Database(required("DATABASE_URL"), schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const store = new Platform(db, new Vault("ac".repeat(32))),
      workflows = new Workflows(store);
    await store.initialize();
    const ids = await store.identity.setup("owner", "test-password-123", "Lists");
    const actor: Principal = {
      id: ids.userId,
      tenantId: ids.tenantId,
      displayName: "Owner",
      kind: "user",
      entry: "console",
    };
    const project = await store.projects.create(actor, { name: "Lists", description: "" });
    const otherProject = await store.projects.create(actor, { name: "Other", description: "" });
    const input = WorkflowAssetInput.parse({
      name: "Draft",
      definition: {
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
        nodes: [
          { id: "start", type: "start", label: "开始" },
          { id: "end", type: "end", label: "结束", values: {} },
        ],
        edges: [{ source: "start", target: "end", port: "out" }],
      },
    });
    const queries = t.mock.method(db, "query");
    async function list() {
      const before = queries.mock.callCount();
      const result = await workflows.list(actor, project.id);
      assert.equal(
        queries.mock.callCount() - before,
        2,
        "one access check and one list query, independent of item count",
      );
      return result.items;
    }
    assert.deepEqual(await list(), []);
    const draft = await workflows.create(actor, project.id, input);
    assert.deepEqual(await list(), [draft]);
    const release = await workflows.publish(actor, project.id, draft.id, 1);
    const updated = await workflows.update(
      actor,
      project.id,
      draft.id,
      { ...input, name: "Unpublished revision" },
      1,
    );
    assert.deepEqual(await list(), [updated]);
    assert.equal(updated.publishedVersion, 1);
    assert.equal(updated.publishedReleaseId, release.id);
    assert.equal(updated.revision, 2);
    await workflows.create(actor, otherProject.id, { ...input, name: "Other project private" });
    const tenantId = randomUUID();
    await db.query("INSERT INTO tenants(id,name) VALUES($1,'Other tenant')", [tenantId]);
    const other: Principal = { ...actor, id: randomUUID(), tenantId };
    const foreignProject = await store.projects.create(other, { name: "Foreign", description: "" });
    await workflows.create(other, foreignProject.id, { ...input, name: "Other tenant private" });
    await assert.rejects(workflows.list(other, project.id), { status: 404 });
    await assert.rejects(
      workflows.list({ ...actor, kind: "application", projectId: project.id }, project.id),
      { status: 403 },
    );
    // Insert a large, ordered fixture without making setup cost part of the list measurement.
    await db.query(
      `INSERT INTO workflows(id,tenant_id,project_id,data,created_at)
       SELECT gen_random_uuid(),$1,$2,$3::jsonb,now()-n*interval '1 minute' FROM generate_series(1,105) n`,
      [actor.tenantId, project.id, input],
    );
    const items = await list();
    assert.equal(items.length, 100);
    assert.deepEqual(items[0], updated);
    assert.ok(items.every((item) => item.projectId === project.id));
    assert.ok(
      items.slice(1).every((item) => item.publishedVersion === null && item.revision === 1),
    );
    assert.deepEqual(
      items.map((item) => item.createdAt),
      items
        .map((item) => item.createdAt)
        .sort()
        .reverse(),
    );
    // Equal timestamps have a stable secondary key; repeated reads do not reshuffle the limit.
    await db.query("UPDATE workflows SET created_at='2026-01-01' WHERE project_id=$1", [
      project.id,
    ]);
    const tied = await list();
    assert.deepEqual(
      tied.map((item) => item.id),
      tied
        .map((item) => item.id)
        .sort()
        .reverse(),
    );
    assert.deepEqual(await list(), tied);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
