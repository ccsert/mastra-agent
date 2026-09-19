import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import type { ApiError } from "../../apps/control-plane/src/infrastructure/errors.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import type { Principal } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

const schema = `test_lifecycle_${process.pid}`,
  admin = new Database(required("DATABASE_URL")),
  db = new Database(required("DATABASE_URL"), schema),
  store = new Platform(db, new Vault("ab".repeat(32)));
let actor: Principal;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await store.initialize();
  const ids = await store.identity.setup("lifecycle-owner", "lifecycle-password-1", "Lifecycle");
  actor = {
    id: ids.userId,
    tenantId: ids.tenantId,
    displayName: "Owner",
    kind: "user",
    entry: "console",
    tenantRole: "owner",
  };
});
after(async () => {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
});

test("changing the password signs out other sessions and accepts only the current one", async () => {
  const kept = await store.identity.login("lifecycle-owner", "lifecycle-password-1");
  const other = await store.identity.login("lifecycle-owner", "lifecycle-password-1");
  await assert.rejects(
    store.identity.changePassword(actor, "wrong-password-123", "lifecycle-password-2", kept),
    (error: ApiError) => error.code === "INVALID_CREDENTIALS",
  );
  const { revoked } = await store.identity.changePassword(
    actor,
    "lifecycle-password-1",
    "lifecycle-password-2",
    kept,
  );
  assert.equal(revoked, 1);
  await store.identity.session(kept);
  await assert.rejects(store.identity.session(other), (error: ApiError) => error.status === 401);
  await store.identity.login("lifecycle-owner", "lifecycle-password-2");
  await assert.rejects(
    store.identity.login("lifecycle-owner", "lifecycle-password-1"),
    (error: ApiError) => error.code === "INVALID_CREDENTIALS",
  );
});

test("revoking other sessions keeps the current session signed in", async () => {
  await db.query("DELETE FROM sessions WHERE user_id=$1", [actor.id]);
  const kept = await store.identity.login("lifecycle-owner", "lifecycle-password-2");
  await store.identity.login("lifecycle-owner", "lifecycle-password-2");
  await store.identity.login("lifecycle-owner", "lifecycle-password-2");
  const { revoked } = await store.identity.revokeOtherSessions(actor, kept);
  assert.equal(revoked, 2);
  await store.identity.session(kept);
});

test("projects can be renamed and archived, which freezes writes until restore", async () => {
  const project = await store.projects.create(actor, { name: "Lifecycle", description: "" });
  const renamed = await store.projects.update(actor, project.id, { name: "Lifecycle v2" });
  assert.equal(renamed.name, "Lifecycle v2");
  assert.equal(renamed.archivedAt, null);

  const archived = await store.projects.setArchived(actor, project.id, true);
  assert.ok(archived.archivedAt);
  const access = store.projects.access;
  await assert.rejects(
    access.require(actor, project.id, "agent.edit"),
    (error: ApiError) => error.code === "PROJECT_ARCHIVED",
  );
  await assert.rejects(
    access.require(actor, project.id, "agent.run"),
    (error: ApiError) => error.code === "PROJECT_ARCHIVED",
  );
  await access.require(actor, project.id, "project.manage");
  await access.require(actor, project.id, "project.read");

  await store.projects.setArchived(actor, project.id, false);
  await access.require(actor, project.id, "agent.edit");
  const audit = await db.query(
    "SELECT action FROM access_audit WHERE tenant_id=$1 AND action LIKE 'project.%' ORDER BY created_at",
    [actor.tenantId],
  );
  assert.deepEqual(
    audit.map((r) => r.action),
    ["project.updated", "project.archived", "project.restored"],
  );
});
