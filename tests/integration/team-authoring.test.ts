import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import type { Principal } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";
import { standardSkill } from "../fixtures/skill-fixture.ts";

const schema = `test_team_${process.pid}`,
  admin = new Database(required("DATABASE_URL")),
  db = new Database(required("DATABASE_URL"), schema);
const platform = new Platform(db, new Vault("ac".repeat(32)));
const { app, queue, workflows } = createApp(platform, {
  origin: "http://console.test",
  runtimeToken: "test-runtime",
});
let owner: Principal, projectId: string, privateProject: string, modelId: string;
const password = "synthetic-test-password-123";
async function account(role: "admin" | "editor" | "member" | "viewer") {
  const invite = await platform.members.invite(owner, {
    label: `Test ${role}`,
    projectId,
    projectRole: role,
  });
  const username = `user_${randomUUID().slice(0, 8)}`;
  const result = await app.request("/api/v1/auth/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, displayName: role, password, token: invite.token }),
  });
  assert.equal(result.status, 200);
  const actor: Principal = await result.json();
  return { actor, cookie: result.headers.get("set-cookie")?.split(";")[0] ?? "", username };
}
async function request(cookie: string, path: string, method = "GET", body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await platform.initialize();
  await platform.identity.setup("team_owner", password, "Team test");
  owner = await platform.identity.session(await platform.identity.login("team_owner", password));
  projectId = (await platform.projects.create(owner, { name: "Shared", description: "" })).id;
  privateProject = (await platform.projects.create(owner, { name: "Private", description: "" })).id;
  modelId = (
    await platform.resources.createModel(owner, projectId, {
      name: "Test model",
      baseUrl: "http://127.0.0.1:9999/v1",
      modelId: "test",
      apiKey: "",
    })
  ).id;
});
after(async () => {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
});

test("project roles restrict discovery, management, publishing and direct module writes", async () => {
  const editor = await account("editor"),
    user = await account("member"),
    viewer = await account("viewer");
  const projects = await (await request(editor.cookie, "/projects")).json();
  assert.deepEqual(
    projects.map((p: { id: string }) => p.id),
    [projectId],
  );
  assert.equal((await request(editor.cookie, `/projects/${privateProject}/agents`)).status, 404);
  assert.equal((await request(user.cookie, `/projects/${projectId}/skills`)).status, 403);
  assert.equal((await request(viewer.cookie, `/projects/${projectId}/skills`)).status, 200);
  assert.equal((await request(editor.cookie, `/projects/${projectId}/members`)).status, 403);
  assert.equal((await request(editor.cookie, "/team/members")).status, 403);
  assert.equal(
    (await request(editor.cookie, `/projects/${projectId}/models`, "POST", {})).status,
    403,
  );
  await assert.rejects(
    () =>
      platform.resources.createModel(editor.actor, projectId, {
        name: "Denied",
        baseUrl: "http://localhost:9999",
        modelId: "denied",
        apiKey: "",
      }),
    { code: "FORBIDDEN" },
  );
  const agent = await platform.agents.create(editor.actor, projectId, {
    name: "Draft",
    instructions: "Say draft",
    modelId,
    toolIds: [],
  });
  assert.equal(
    (
      await request(editor.cookie, `/projects/${projectId}/agents/${agent.id}/publish`, "POST", {
        baseRevision: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(viewer.cookie, `/projects/${projectId}/agents/${agent.id}/preview`, "POST", {
        baseRevision: 1,
        requestId: randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal(
    (await platform.agents.list(user.actor, projectId)).some((a) => a.id === agent.id),
    false,
  );
  await platform.agents.publish(owner, projectId, agent.id, 1);
  await platform.agents.update(
    editor.actor,
    projectId,
    agent.id,
    { name: "Unpublished name", instructions: "Changed", modelId, toolIds: [] },
    1,
  );
  assert.equal(
    (await platform.agents.list(user.actor, projectId)).find((a) => a.id === agent.id)?.name,
    "Draft",
  );
  assert.equal(
    (await platform.agents.list(editor.actor, projectId)).find((a) => a.id === agent.id)
      ?.hasUnpublishedChanges,
    true,
  );
  assert.equal(
    (
      await request(viewer.cookie, `/projects/${projectId}/conversations`, "POST", {
        agentId: agent.id,
      })
    ).status,
    403,
  );
});

test("single-use invitations serialize acceptance and hide secrets from the audit", async () => {
  const invite = await platform.members.invite(owner, {
    label: "Concurrent",
    projectId,
    projectRole: "member",
  });
  const outcomes = await Promise.allSettled(
    ["first", "second"].map((suffix) =>
      platform.members.join({
        token: invite.token,
        username: `join_${suffix}`,
        displayName: suffix,
        password,
      }),
    ),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const revoked = await platform.members.invite(owner, {
    label: "Revoked",
    projectId,
    projectRole: "viewer",
  });
  await platform.members.revokeInvitation(owner, revoked.invitation.id);
  await assert.rejects(
    () =>
      platform.members.join({
        token: revoked.token,
        username: "revoked_user",
        displayName: "revoked",
        password,
      }),
    { code: "INVITATION_INVALID" },
  );
  const audit = JSON.stringify(await platform.members.audit(owner));
  assert.ok(audit.includes("invitation.accepted"));
  assert.ok(!audit.includes(invite.token) && !audit.includes(password));
});

test("membership changes immediately revoke old-session permissions and protect the owner", async () => {
  const editor = await account("editor");
  await platform.members.setProjectMember(owner, projectId, editor.actor.id, "viewer");
  assert.equal(
    (await request(editor.cookie, `/projects/${projectId}/agents`, "POST", {})).status,
    403,
  );
  await platform.members.setProjectMember(owner, projectId, editor.actor.id, null);
  assert.equal((await request(editor.cookie, `/projects/${projectId}/agents`)).status, 404);
  await platform.members.update(owner, editor.actor.id, { role: "member", active: false });
  assert.equal((await request(editor.cookie, "/me")).status, 401);
  await assert.rejects(() => platform.identity.login(editor.username, password), {
    code: "INVALID_CREDENTIALS",
  });
  await assert.rejects(
    () => platform.members.update(owner, owner.id, { role: "member", active: false }),
    { code: "OWNER_PROTECTED" },
  );
});

test("draft previews execute an immutable snapshot without publishing or leaking through workflows", async () => {
  const editor = await account("editor"),
    another = await account("editor");
  const agent = await platform.agents.create(editor.actor, projectId, {
    name: "Preview",
    instructions: "draft one",
    modelId,
    toolIds: [],
  });
  const requestId = randomUUID();
  const preview = await platform.agents.preview(editor.actor, projectId, agent.id, 1, requestId);
  assert.deepEqual(
    await platform.agents.preview(editor.actor, projectId, agent.id, 1, requestId),
    preview,
  );
  assert.equal((await platform.agents.releases(owner, projectId, agent.id)).length, 0);
  assert.equal(
    (await platform.agents.list(owner, projectId)).find((a) => a.id === agent.id)
      ?.publishedReleaseId,
    null,
  );
  await assert.rejects(
    () => platform.conversations.create(editor.actor, projectId, agent.id, "formal"),
    { code: "AGENT_NOT_PUBLISHED" },
  );
  await assert.rejects(
    () => platform.conversations.get(another.actor, projectId, preview.conversationId),
    { code: "NOT_FOUND" },
  );
  await platform.agents.update(
    editor.actor,
    projectId,
    agent.id,
    { name: "Preview", instructions: "draft two", modelId, toolIds: [] },
    1,
  );
  await assert.rejects(
    () => platform.agents.preview(editor.actor, projectId, agent.id, 1, randomUUID()),
    { code: "DRAFT_CONFLICT" },
  );
  const run = await platform.conversations.createRun(
    editor.actor,
    projectId,
    preview.conversationId,
    "hello",
    "preview-run",
  );
  const job = await queue.claim();
  assert.equal(job?.runId, run.id);
  assert.equal(job?.snapshot.agent.instructions, "draft one");
  await platform.conversations.cancel(editor.actor, projectId, run.id);
  assert.ok(!JSON.stringify(await workflows.catalog(owner, projectId)).includes(preview.releaseId));
  const published = await platform.agents.publish(owner, projectId, agent.id, 2);
  assert.equal(published.version, 1);
  const formal = await platform.conversations.create(editor.actor, projectId, agent.id, "formal");
  assert.equal(formal.releaseId, published.id);
  assert.notEqual(formal.id, preview.conversationId);
  assert.equal(
    (await platform.conversations.get(editor.actor, projectId, preview.conversationId)).releaseId,
    preview.releaseId,
  );
  await platform.members.setProjectMember(owner, projectId, editor.actor.id, "member");
  await assert.rejects(
    () => platform.conversations.get(editor.actor, projectId, preview.conversationId),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(() => platform.conversations.run(editor.actor, projectId, run.id), {
    code: "FORBIDDEN",
  });
  assert.ok(
    !(await platform.conversations.list(editor.actor, projectId)).items.some(
      (c) => c.id === preview.conversationId,
    ),
  );
  assert.ok(
    !(await platform.conversations.summaries(editor.actor, projectId)).items.some(
      (c) => c.id === preview.conversationId,
    ),
  );
});

test("team administration prevents escalation, tenant crossing and stale invitations", async () => {
  const manager = await account("admin"),
    target = await account("member");
  await platform.members.update(owner, manager.actor.id, { role: "admin", active: true });
  await assert.rejects(
    () => platform.members.update(manager.actor, target.actor.id, { role: "admin", active: true }),
    { code: "OWNER_REQUIRED" },
  );
  await assert.rejects(() => platform.members.transfer(manager.actor, target.actor.id), {
    code: "OWNER_REQUIRED",
  });
  const foreignTenant = randomUUID(),
    foreignUser = randomUUID();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign test')", [foreignTenant]);
  await db.query(
    "INSERT INTO users(id,tenant_id,username,password_hash,display_name,role) VALUES($1,$2,$3,'unused','Foreign','owner')",
    [foreignUser, foreignTenant, `foreign_${foreignUser}`],
  );
  await assert.rejects(
    () => platform.members.setProjectMember(owner, projectId, foreignUser, "admin"),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(() => platform.members.transfer(owner, foreignUser), { code: "NOT_FOUND" });
  const projectManager = await account("admin");
  const invite = await platform.members.invite(projectManager.actor, {
    label: "Before demotion",
    projectId,
    projectRole: "admin",
  });
  await platform.members.setProjectMember(owner, projectId, projectManager.actor.id, "member");
  await assert.rejects(
    () =>
      platform.members.join({
        token: invite.token,
        username: "stale_invite",
        displayName: "Stale",
        password,
      }),
    { code: "INVITATION_INVALID" },
  );
  await platform.members.transfer(owner, target.actor.id);
  assert.equal(await platform.projects.access.tenant(owner), "admin");
  assert.equal(await platform.projects.access.tenant(target.actor), "owner");
  await assert.rejects(() => platform.members.transfer(owner, manager.actor.id), {
    code: "OWNER_REQUIRED",
  });
  assert.equal(
    (await db.query("SELECT id FROM users WHERE tenant_id=$1 AND role='owner'", [owner.tenantId]))
      .length,
    1,
  );
  await platform.members.transfer(target.actor, owner.id);
});

test("editors can import instructions but cannot authorize new script execution", async () => {
  const editor = await account("editor");
  const skill = await platform.skills.upload(editor.actor, projectId, standardSkill());
  const binding = { versionId: skill.id, entrypoints: ["scripts/report.mjs"] };
  const input = {
    name: "Script boundary",
    modelId,
    instructions: "Use the approved skill",
    toolIds: [],
    skillBindings: [binding],
  };
  await assert.rejects(() => platform.agents.create(editor.actor, projectId, input), {
    code: "SKILL_AUTHORIZATION_REQUIRED",
  });
  const agent = await platform.agents.create(owner, projectId, input);
  await assert.rejects(
    () => platform.agents.preview(editor.actor, projectId, agent.id, 1, randomUUID()),
    { code: "SKILL_AUTHORIZATION_REQUIRED" },
  );
  await platform.agents.publish(owner, projectId, agent.id, 1);
  const updated = await platform.agents.update(
    editor.actor,
    projectId,
    agent.id,
    { ...input, name: "Keep approved script" },
    1,
  );
  assert.equal(
    (
      await platform.agents.preview(
        editor.actor,
        projectId,
        agent.id,
        updated.draftRevision,
        randomUUID(),
      )
    ).draftRevision,
    2,
  );
  const newer = await platform.skills.upload(editor.actor, projectId, standardSkill("TWO"));
  await assert.rejects(
    () =>
      platform.agents.update(
        editor.actor,
        projectId,
        agent.id,
        { ...input, skillBindings: [{ ...binding, versionId: newer.id }] },
        2,
      ),
    { code: "SKILL_AUTHORIZATION_REQUIRED" },
  );
  await assert.rejects(() => platform.skills.setEnabled(editor.actor, projectId, skill.id, false), {
    code: "FORBIDDEN",
  });
});
