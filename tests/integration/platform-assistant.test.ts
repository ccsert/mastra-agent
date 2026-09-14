import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import {
  AgentAppManifest,
  AgentAppReceipt,
  AgentAppView,
  AssistantCapabilities,
  AssistantProposal,
  type AssistantToolRequest,
  AssistantUiReceipt,
  AssistantUiView,
  type ExecutionJob,
  type Principal,
  platformAppManifest,
  platformAppRegistrationId,
  z,
} from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

const schema = `test_assistant_${process.pid}`,
  admin = new Database(required("DATABASE_URL")),
  db = new Database(required("DATABASE_URL"), schema);
const platform = new Platform(db, new Vault("ac".repeat(32)));
const { app, queue, assistant } = createApp(platform, {
  origin: "http://console.test",
  runtimeToken: "test-runtime",
});
let owner: Principal, projectId: string, modelId: string;
const password = "synthetic-test-password-123";
async function account(role: "admin" | "editor" | "member" | "viewer") {
  const invite = await platform.members.invite(owner, {
    label: `Test ${role}`,
    projectId,
    projectRole: role,
  });
  const response = await app.request("/api/v1/auth/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: `assistant_${randomUUID().slice(0, 8)}`,
      displayName: role,
      password,
      token: invite.token,
    }),
  });
  assert.equal(response.status, 200);
  const actor: Principal = await response.json();
  return { actor, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
async function session(actor = owner, message?: string) {
  return assistant.start(actor, projectId, {
    requestId: randomUUID(),
    context: { page: "agents" },
    ...(message ? { message } : {}),
  });
}
async function jobFor(actor = owner) {
  const current = await session(actor);
  await platform.conversations.createRun(
    actor,
    projectId,
    current.id,
    "synthetic test",
    randomUUID(),
    [],
    true,
  );
  const job = await queue.claim();
  assert.ok(job);
  assert.equal(job.conversationId, current.id);
  return { current, job };
}
function call(
  job: ExecutionJob,
  tool: z.infer<typeof AssistantToolRequest>["tool"],
  input: Record<string, unknown>,
  toolCallId = randomUUID(),
) {
  return assistant.runtime(job.runId, { leaseToken: job.leaseToken, toolCallId, tool, input });
}
const draft = (name = "Synthetic assistant draft") => ({
  name,
  instructions: "Use only explicitly requested capabilities.",
  modelId,
  toolIds: [],
});
async function propose(
  job: ExecutionJob,
  actions: Record<string, unknown>[],
  toolCallId = randomUUID(),
) {
  const result = await call(
    job,
    "propose",
    { title: "合成验收变更", reason: "仅供功能验证", actions },
    toolCallId,
  );
  return z.object({ proposal: AssistantProposal }).parse(result).proposal;
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await platform.initialize();
  await platform.identity.setup("assistant_owner", password, "Assistant test");
  owner = await platform.identity.session(
    await platform.identity.login("assistant_owner", password),
  );
  projectId = (await platform.projects.create(owner, { name: "Assistant test", description: "" }))
    .id;
  modelId = (
    await platform.resources.createModel(owner, projectId, {
      name: "Fixture",
      baseUrl: "http://127.0.0.1:9999/v1",
      modelId: "test",
      apiKey: "synthetic-secret",
    })
  ).id;
  await assistant.configure(owner, projectId, modelId);
});
after(async () => {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
});

test("start enqueues once, snapshots only built-in identity, and hides tasks from other users", async () => {
  const input = {
    requestId: randomUUID(),
    context: { page: "agents" as const },
    message: "合成验收，请解释平台",
  };
  const [first, second] = await Promise.all([
    assistant.start(owner, projectId, input),
    assistant.start(owner, projectId, input),
  ]);
  assert.equal(first.id, second.id);
  const runs = await db.query("SELECT id FROM runs WHERE conversation_id=$1", [first.id]);
  assert.equal(runs.length, 1);
  const job = await queue.claim();
  assert.ok(job?.systemAssistant);
  assert.equal(job.systemAssistant.page, "agents");
  assert.deepEqual(job.snapshot.tools, []);
  assert.deepEqual(job.snapshot.skills, []);
  assert.equal(JSON.stringify(job.snapshot).includes("synthetic-secret"), false);
  const other = await account("admin");
  assert.equal(
    (await assistant.bootstrap(other.actor, projectId)).sessions.some((s) => s.id === first.id),
    false,
  );
  await assert.rejects(assistant.proposals(other.actor, projectId, first.id), {
    code: "NOT_FOUND",
  });
  const [resource] = await db.query(
    "SELECT kind FROM resources WHERE id=(SELECT agent_id FROM conversations WHERE id=$1)",
    [first.id],
  );
  assert.equal(resource.kind, "assistant");
  assert.equal(
    (await platform.conversations.list(owner, projectId)).items.some((c) => c.id === first.id),
    false,
  );
  assert.equal(
    (await platform.agents.list(owner, projectId)).some((a) => a.name === "平台助手"),
    false,
  );
});

test("viewer can ask and read with the same identity but cannot configure or propose writes", async () => {
  const viewer = await account("viewer");
  const { job, current } = await jobFor(viewer.actor);
  const catalog = z
    .object({ operations: z.array(z.object({ id: z.string(), mode: z.string() })) })
    .parse(await call(job, "catalog", {}));
  assert.ok(catalog.operations.some((o) => o.id === "model.list"));
  assert.ok(catalog.operations.every((o) => o.mode === "read"));
  await assert.rejects(propose(job, [{ key: "a", operation: "agent.create", input: draft() }]), {
    code: "OPERATION_NOT_ALLOWED",
  });
  await assert.rejects(assistant.configure(viewer.actor, projectId, modelId), {
    code: "FORBIDDEN",
  });
  const response = await app.request(
    `/api/v1/projects/${projectId}/assistant/runs/${job.runId}/cancel`,
    {
      method: "POST",
      headers: { cookie: viewer.cookie, "content-type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(response.status, 200);
  await assert.rejects(call(job, "read", { operation: "access.read" }), {
    code: "ASSISTANT_LEASE_EXPIRED",
  });
  await assert.rejects(
    platform.conversations.createRun(
      viewer.actor,
      projectId,
      current.id,
      "ordinary route",
      randomUUID(),
    ),
    { code: "FORBIDDEN" },
  );
});

test("proposals make no business writes; concurrent application creates dependent Skill and Agent once", async () => {
  const { job, current } = await jobFor();
  const before = (await platform.agents.list(owner, projectId)).length;
  const actions = [
    {
      key: "guide",
      operation: "skill.create",
      input: {
        name: `synthetic-${randomUUID().slice(0, 8)}`,
        description: "Synthetic instruction skill",
        instructions: "Use supplied facts; never invent enterprise policy.",
      },
    },
    {
      key: "agent",
      operation: "agent.create",
      input: { ...draft(), skillBindings: [{ versionId: "$step.guide.id", entrypoints: [] }] },
    },
  ];
  const id = randomUUID();
  const proposal = await propose(job, actions, id);
  assert.equal((await propose(job, actions, id)).id, proposal.id);
  assert.equal((await platform.agents.list(owner, projectId)).length, before);
  await assert.rejects(
    propose(job, [{ key: "a", operation: "agent.create", input: draft("different") }], id),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await Promise.all([
    assistant.apply(owner, projectId, current.id, proposal.id),
    assistant.apply(owner, projectId, current.id, proposal.id),
  ]);
  const result = (await assistant.proposals(owner, projectId, current.id))[0];
  assert.equal(result.status, "succeeded");
  assert.ok(result.actions.every((a) => a.status === "succeeded"));
  const agents = await platform.agents.list(owner, projectId);
  assert.equal(agents.length, before + 1);
  const created = agents.find((a) => a.id === result.actions[1]?.result?.id);
  assert.ok(created);
  assert.equal(created.skillBindings[0]?.versionId, result.actions[0]?.result?.id);
  assert.deepEqual(created.toolIds, []);
  await assistant.apply(owner, projectId, current.id, proposal.id);
  assert.equal((await platform.agents.list(owner, projectId)).length, before + 1);
});

test("apply rechecks role and version; foreign resources and mixed approval groups cannot be changed", async () => {
  const editor = await account("editor"),
    { job, current } = await jobFor(editor.actor);
  const proposal = await propose(job, [{ key: "a", operation: "agent.create", input: draft() }]);
  await platform.members.setProjectMember(owner, projectId, editor.actor.id, "viewer");
  await assert.rejects(assistant.apply(editor.actor, projectId, current.id, proposal.id), {
    code: "OPERATION_NOT_ALLOWED",
  });
  const { job: ownerJob, current: ownerSession } = await jobFor();
  const agent = await platform.agents.create(owner, projectId, draft("Stale target"));
  const stale = await propose(ownerJob, [
    {
      key: "a",
      operation: "agent.update",
      input: { id: agent.id, definition: { ...draft("proposed"), baseRevision: 1 } },
    },
  ]);
  await platform.agents.update(owner, projectId, agent.id, draft("newer"), 1);
  const staleResult = await assistant.apply(owner, projectId, ownerSession.id, stale.id);
  assert.equal(staleResult.status, "failed");
  assert.equal(staleResult.actions[0].status, "failed");
  assert.equal(
    (await platform.agents.list(owner, projectId)).find((a) => a.id === agent.id)?.name,
    "newer",
  );
  await assert.rejects(
    propose(ownerJob, [
      { key: "publish", operation: "agent.publish", input: { id: agent.id, baseRevision: 2 } },
      { key: "draft", operation: "agent.create", input: draft() },
    ]),
    { code: "SEPARATE_APPROVAL" },
  );
  const foreignProject = (
    await platform.projects.create(owner, { name: "Foreign", description: "" })
  ).id;
  const foreignModel = (
    await platform.resources.createModel(owner, foreignProject, {
      name: "Foreign",
      baseUrl: "http://localhost:9999/v1",
      modelId: "test",
      apiKey: "",
    })
  ).id;
  const foreign = await propose(ownerJob, [
    { key: "a", operation: "agent.create", input: { ...draft(), modelId: foreignModel } },
  ]);
  const denied = await assistant.apply(owner, projectId, ownerSession.id, foreign.id);
  assert.equal(denied.status, "failed");
});

test("canonical session, active lease and current membership are required for every runtime operation", async () => {
  const { job } = await jobFor();
  await assert.rejects(
    assistant.runtime(job.runId, {
      leaseToken: "wrong",
      tool: "catalog",
      toolCallId: randomUUID(),
      input: {},
    }),
    { code: "ASSISTANT_LEASE_EXPIRED" },
  );
  const user = await account("editor"),
    pending = await session(user.actor, "pending");
  await platform.members.setProjectMember(owner, projectId, user.actor.id, null);
  assert.equal(await queue.claim(), null);
  const [failed] = await db.query("SELECT status,error_code FROM runs WHERE conversation_id=$1", [
    pending.id,
  ]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "FORBIDDEN");
  const ordinary = await platform.agents.create(owner, projectId, draft("Ordinary"));
  await platform.agents.publish(owner, projectId, ordinary.id, 1);
  const conv = await platform.conversations.create(owner, projectId, ordinary.id, "Ordinary");
  const run = await platform.conversations.createRun(
    owner,
    projectId,
    conv.id,
    "ordinary",
    randomUUID(),
  );
  const ordinaryJob = await queue.claim();
  assert.ok(ordinaryJob);
  assert.equal(ordinaryJob.systemAssistant, undefined);
  await assert.rejects(call(ordinaryJob, "catalog", {}), { code: "ASSISTANT_LEASE_EXPIRED" });
  assert.equal(ordinaryJob.runId, run.id);
  await db.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.runId]);
  await assert.rejects(call(job, "skill", { id: "platform-guide" }), {
    code: "ASSISTANT_LEASE_EXPIRED",
  });
});

test("secret fields and arbitrary operations are rejected; navigation stays permission scoped", async () => {
  const { job } = await jobFor();
  await assert.rejects(
    propose(job, [
      {
        key: "model",
        operation: "model.create",
        input: {
          name: "Bad",
          baseUrl: "http://localhost:9999",
          modelId: "test",
          apiKey: "do-not-store",
        },
      },
    ]),
    { code: "INVALID_ACTION" },
  );
  await assert.rejects(
    propose(job, [{ key: "exec", operation: "shell.exec", input: { command: "true" } }]),
    { code: "OPERATION_NOT_ALLOWED" },
  );
  const viewer = await account("viewer"),
    { job: viewerJob } = await jobFor(viewer.actor);
  await assert.rejects(call(viewerJob, "navigate", { page: "settings" }), { code: "FORBIDDEN" });
  const nav = await call(viewerJob, "navigate", { page: "knowledge" });
  assert.equal(z.object({ execution: z.string() }).parse(nav).execution, "suggestion");
});

test("expired plans can be dismissed after role reduction, while partial or uncertain outcomes never replay", async (t) => {
  const editor = await account("editor"),
    { job, current } = await jobFor(editor.actor);
  const expired = await propose(job, [{ key: "a", operation: "agent.create", input: draft() }]);
  await db.query(
    "UPDATE platform_assistant_proposals SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(assistant.apply(editor.actor, projectId, current.id, expired.id), {
    code: "PROPOSAL_EXPIRED",
  });
  await platform.members.setProjectMember(owner, projectId, editor.actor.id, "viewer");
  assert.equal(
    (await assistant.apply(editor.actor, projectId, current.id, expired.id, true)).status,
    "dismissed",
  );
  const own = await jobFor();
  const count = (await platform.agents.list(owner, projectId)).length;
  const partial = await propose(own.job, [
    { key: "first", operation: "agent.create", input: draft("kept") },
    {
      key: "invalid",
      operation: "agent.create",
      input: { ...draft("invalid"), modelId: randomUUID() },
    },
  ]);
  const result = await assistant.apply(owner, projectId, own.current.id, partial.id);
  assert.equal(result.actions[0].status, "succeeded");
  assert.equal(result.actions[1].status, "failed");
  await assistant.apply(owner, projectId, own.current.id, partial.id);
  assert.equal((await platform.agents.list(owner, projectId)).length, count + 1);
  const unknown = await propose(own.job, [
    { key: "unknown", operation: "agent.create", input: draft("uncertain") },
  ]);
  const operation = assistant.registry.find((o) => o.id === "agent.create");
  assert.ok(operation);
  let attempts = 0;
  t.mock.method(operation, "run", async () => {
    attempts++;
    throw new Error("lost acknowledgement");
  });
  assert.equal(
    (await assistant.apply(owner, projectId, own.current.id, unknown.id)).actions[0].status,
    "unknown",
  );
  await assistant.apply(owner, projectId, own.current.id, unknown.id);
  assert.equal(attempts, 1);
});

test("read catalogs provide schemas, resource lists stay compact, and Skill files are decoded text", async () => {
  const { job } = await jobFor();
  const catalog = z
    .object({
      operations: z.array(
        z.object({ id: z.string(), mode: z.string(), schema: z.unknown().optional() }),
      ),
    })
    .parse(await call(job, "catalog", { group: "agent" }));
  assert.ok(catalog.operations.find((o) => o.id === "agent.get")?.schema);
  assert.equal(catalog.operations.find((o) => o.id === "agent.create")?.schema, undefined);
  const list = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(
    await call(job, "read", {
      operation: "agent.list",
      input: { query: "Synthetic assistant draft" },
    }),
  );
  assert.ok(list.items.length);
  assert.ok(list.items.every((a) => !("instructions" in a)));
  const skills = await platform.skills.list(owner, projectId);
  const skill = skills.items.find((s) => s.name.startsWith("synthetic-"));
  assert.ok(skill);
  const file = z.object({ text: z.string(), hash: z.string(), truncated: z.boolean() }).parse(
    await call(job, "read", {
      operation: "skill.file",
      input: { id: skill.id, path: "SKILL.md" },
    }),
  );
  assert.match(file.text, /Use supplied facts/);
  assert.equal(file.truncated, false);
});

test("assistant does not grant Skill scripts and page suggestions match console role gates", async () => {
  const { job } = await jobFor();
  await assert.rejects(
    propose(job, [
      {
        key: "script",
        operation: "agent.create",
        input: {
          ...draft(),
          skillBindings: [{ versionId: randomUUID(), entrypoints: ["scripts/run.py"] }],
        },
      },
    ]),
    { code: "INVALID_ACTION" },
  );
  const member = await account("member"),
    { job: memberJob } = await jobFor(member.actor);
  await assert.rejects(call(memberJob, "navigate", { page: "agents", resourceId: randomUUID() }), {
    code: "FORBIDDEN",
  });
  const viewer = await account("viewer"),
    { job: viewerJob } = await jobFor(viewer.actor);
  for (const page of ["workflows", "models", "mcp"])
    await assert.rejects(call(viewerJob, "navigate", { page }), { code: "FORBIDDEN" });
  for (const page of ["skills", "tools"]) assert.ok(await call(viewerJob, "navigate", { page }));
});

test("capability directory exposes documented system definitions without granting writes or creating tasks", async () => {
  const viewer = await account("viewer");
  const before = (await assistant.bootstrap(viewer.actor, projectId)).sessions.length;
  const response = await app.request(`/api/v1/projects/${projectId}/assistant/capabilities`, {
    headers: { cookie: viewer.cookie },
  });
  assert.equal(response.status, 200);
  const catalog = AssistantCapabilities.parse(await response.json());
  assert.equal(catalog.skills.length, 5);
  assert.equal(catalog.tools.length, 7);
  assert.equal(catalog.operations.length, assistant.registry.length);
  assert.equal(
    catalog.skills.find((s) => s.id === "agent-builder")?.instructions.includes("最小集合"),
    true,
  );
  assert.ok(
    catalog.skills.every(
      (s) => s.readOnly && !s.bindable && s.digest.length === 64 && s.usage.count === 0,
    ),
  );
  assert.equal(catalog.tools.find((s) => s.id === "platform_propose")?.available, false);
  assert.ok(
    catalog.operations
      .filter((o) => o.mode === "write")
      .every((o) => !o.available && o.unavailableReason),
  );
  const detail = await app.request(
    `/api/v1/projects/${projectId}/assistant/capabilities/operations/model.create`,
    { headers: { cookie: viewer.cookie } },
  );
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.equal(body.available, false);
  assert.ok(body.inputSchema);
  assert.equal(JSON.stringify(body.inputSchema).includes('"apiKey"'), false);
  assert.equal(JSON.stringify(catalog).includes("synthetic-secret"), false);
  assert.equal((await assistant.bootstrap(viewer.actor, projectId)).sessions.length, before);
  assert.ok(await platform.resources.tools(viewer.actor, projectId));
  assert.ok(await platform.skills.list(viewer.actor, projectId));
  await assert.rejects(
    platform.resources.createTool(viewer.actor, projectId, {
      name: "forbidden_tool",
      description: "Forbidden",
      kind: "sum",
      url: "",
      bearerToken: "",
      inputSchema: {},
      outputSchema: {},
    }),
    { code: "FORBIDDEN" },
  );
  await platform.members.setProjectMember(owner, projectId, viewer.actor.id, "editor");
  const changed = await assistant.capabilities(viewer.actor, projectId);
  assert.equal(changed.operations.find((o) => o.id === "agent.create")?.available, true);
  assert.equal(changed.operations.find((o) => o.id === "model.create")?.available, false);
  await platform.members.setProjectMember(owner, projectId, viewer.actor.id, null);
  await assert.rejects(assistant.capabilities(viewer.actor, projectId), { code: "NOT_FOUND" });
  const unconfigured = await platform.projects.create(owner, {
    name: "Catalog without model",
    description: "",
  });
  assert.equal((await assistant.capabilities(owner, unconfigured.id)).tools.length, 7);
});

test("task capability usage counts successful calls once, survives reload, and is isolated by owner and project", async () => {
  const { job, current } = await jobFor();
  const event = (seq: number, chunk: object) =>
    db.query("INSERT INTO run_events(run_id,seq,chunk) VALUES($1,$2,$3)", [
      job.runId,
      seq,
      JSON.stringify(chunk),
    ]);
  await event(1, {
    type: "tool-input-available",
    toolCallId: "ok",
    toolName: "platform_skill",
    input: { id: "agent-builder" },
  });
  await event(2, {
    type: "tool-output-available",
    toolCallId: "ok",
    output: { skill: { id: "agent-builder" }, version: 1 },
  });
  await event(3, {
    type: "tool-output-available",
    toolCallId: "ok",
    output: { skill: { id: "agent-builder" }, version: 1 },
  });
  await event(4, {
    type: "tool-input-available",
    toolCallId: "failed",
    toolName: "platform_skill",
    input: { id: "platform-guide" },
  });
  await event(5, { type: "tool-output-error", toolCallId: "failed", errorText: "synthetic error" });
  await event(6, {
    type: "tool-input-available",
    toolCallId: "pending",
    toolName: "platform_skill",
    input: { id: "platform-guide" },
  });
  const usage = await assistant.capabilities(owner, projectId, current.id);
  assert.equal(usage.skills.find((s) => s.id === "agent-builder")?.usage.count, 1);
  assert.equal(usage.skills.find((s) => s.id === "platform-guide")?.usage.count, 0);
  assert.equal(usage.tools.find((s) => s.id === "platform_skill")?.usage.count, 1);
  assert.deepEqual(await assistant.capabilities(owner, projectId, current.id), usage);
  const another = await session();
  assert.ok(
    (await assistant.capabilities(owner, projectId, another.id)).skills.every(
      (s) => s.usage.count === 0,
    ),
  );
  const adminMember = await account("admin");
  const denied = await app.request(
    `/api/v1/projects/${projectId}/assistant/capabilities?conversationId=${current.id}`,
    { headers: { cookie: adminMember.cookie } },
  );
  assert.equal(denied.status, 404);
  const foreign = await platform.projects.create(owner, {
    name: "Usage isolation",
    description: "",
  });
  await assert.rejects(assistant.capabilities(owner, foreign.id, current.id), {
    code: "NOT_FOUND",
  });
});

test("clear creates an empty same-release session, preserves history, is idempotent and owned", async () => {
  const { current, job } = await jobFor();
  await assert.rejects(platform.conversations.reset(owner, projectId, current.id, randomUUID()), {
    code: "CONVERSATION_BUSY",
  });
  await queue.finish(job.runId, {
    leaseToken: job.leaseToken,
    status: "succeeded",
    message: { id: "answer", role: "assistant", parts: [{ type: "text", text: "保留的原始回答" }] },
  });
  const requestId = randomUUID();
  const [next, duplicate] = await Promise.all([
    platform.conversations.reset(owner, projectId, current.id, requestId),
    platform.conversations.reset(owner, projectId, current.id, requestId),
  ]);
  assert.equal(next.id, duplicate.id);
  assert.notEqual(next.id, current.id);
  assert.equal(
    next.releaseId,
    (await platform.conversations.get(owner, projectId, current.id)).releaseId,
  );
  assert.equal(
    (await platform.conversations.session(owner, projectId, next.id)).messages.length,
    0,
  );
  assert.equal(
    (await platform.conversations.session(owner, projectId, current.id)).messages.length,
    2,
  );
  await assistant.session(owner, projectId, next.id);
  const { actor } = await account("admin");
  await assert.rejects(platform.conversations.reset(actor, projectId, current.id, randomUUID()), {
    code: "NOT_FOUND",
  });
});

test("compaction checkpoints only successful summaries and preserves original goal and trace", async () => {
  const { current, job } = await jobFor();
  await queue.finish(job.runId, {
    leaseToken: job.leaseToken,
    status: "succeeded",
    message: {
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "已验证事实 A，资源 id-B；还没有保存草稿" }],
    },
  });
  const run = await platform.conversations.createRun(
    owner,
    projectId,
    current.id,
    "/compact 保留待办",
    randomUUID(),
    [],
    true,
  );
  const compact = await queue.claim();
  assert.equal(compact?.runId, run.id);
  assert.ok(compact?.compaction?.transcript.includes("已验证事实 A"));
  assert.equal(compact.systemAssistant, undefined);
  assert.deepEqual(compact.snapshot.tools, []);
  assert.deepEqual(compact.snapshot.skills, []);
  assert.equal(compact.snapshot.agent.workspaceEnabled, false);
  assert.equal(compact.snapshot.agent.maxSteps, 1);
  await queue.finish(compact.runId, {
    leaseToken: compact.leaseToken,
    status: "succeeded",
    message: {
      id: "summary",
      role: "assistant",
      parts: [{ type: "text", text: "事实 A；资源 id-B；待用户保存草稿。" }],
    },
  });
  const context = await platform.conversations.context(owner, projectId, current.id);
  assert.equal(context.coveredMessages, 4);
  assert.equal(context.totalMessages, 4);
  assert.equal(context.summary, "事实 A；资源 id-B；待用户保存草稿。");
  await platform.conversations.createRun(
    owner,
    projectId,
    current.id,
    "继续下一步",
    randomUUID(),
    [],
    true,
  );
  const next = await queue.claim();
  assert.ok(next);
  assert.equal(next.messages.length, 3);
  assert.ok(JSON.stringify(next.messages[0]).includes("synthetic test"));
  assert.ok(JSON.stringify(next.messages[1]).includes("事实 A"));
  assert.ok(!JSON.stringify(next.messages).includes("已验证事实 A"));
  assert.equal(
    (await platform.conversations.session(owner, projectId, current.id)).messages.length,
    5,
  );
  await queue.finish(next.runId, {
    leaseToken: next.leaseToken,
    status: "failed",
    errorCode: "MODEL_ERROR",
  });
  await platform.conversations.createRun(
    owner,
    projectId,
    current.id,
    "/compact",
    randomUUID(),
    [],
    true,
  );
  const failed = await queue.claim();
  assert.ok(failed);
  await queue.finish(failed.runId, {
    leaseToken: failed.leaseToken,
    status: "failed",
    errorCode: "MODEL_ERROR",
  });
  assert.equal(
    (await platform.conversations.context(owner, projectId, current.id)).runId,
    compact.runId,
  );
  await platform.conversations.createRun(
    owner,
    projectId,
    current.id,
    "/compact",
    randomUUID(),
    [],
    true,
  );
  const cancelled = await queue.claim();
  assert.ok(cancelled);
  await platform.conversations.cancel(owner, projectId, cancelled.runId);
  await queue.finish(cancelled.runId, {
    leaseToken: cancelled.leaseToken,
    status: "succeeded",
    message: { id: "bad", role: "assistant", parts: [{ type: "text", text: "取消后不应保存" }] },
  });
  assert.equal(
    (await platform.conversations.context(owner, projectId, current.id)).runId,
    compact.runId,
  );
});

test("page collaboration needs an explicit live tab, validates revisions and claims actions once", async () => {
  const { current, job } = await jobFor();
  const clientId = randomUUID(),
    view = AssistantUiView.parse({
      revision: randomUUID(),
      page: "skills",
      targets: [
        {
          id: "skills.source",
          label: "来源",
          kind: "select",
          value: "project",
          options: ["project", "system"],
        },
      ],
    });
  await assert.rejects(call(job, "ui", { operation: "inspect" }), { code: "UI_NOT_CONNECTED" });
  assert.equal(
    (
      await assistant.syncUi(owner, projectId, current.id, {
        enabled: true,
        grant: false,
        clientId,
        view,
      })
    ).active,
    false,
  );
  await assistant.syncUi(owner, projectId, current.id, {
    enabled: true,
    grant: true,
    clientId,
    view,
  });
  await assert.rejects(
    assistant.syncUi(owner, projectId, current.id, {
      enabled: true,
      grant: true,
      clientId: randomUUID(),
      view,
    }),
    { code: "UI_IN_USE" },
  );
  assert.equal(
    AssistantUiView.extend({ type: z.string() }).parse(
      await call(job, "ui", { operation: "inspect" }),
    ).revision,
    view.revision,
  );
  await assert.rejects(
    call(job, "ui", {
      operation: "act",
      target: "skills.source",
      value: "system",
      viewRevision: randomUUID(),
    }),
    { code: "UI_VIEW_CHANGED" },
  );
  await assert.rejects(
    call(job, "ui", {
      operation: "act",
      target: "skills.source",
      value: "other",
      viewRevision: view.revision,
    }),
    { code: "UI_VALUE_INVALID" },
  );
  await assert.rejects(
    call(job, "ui", {
      operation: "act",
      target: "execute_js",
      value: "alert(1)",
      viewRevision: view.revision,
    }),
  );
  const input = {
      operation: "act",
      target: "skills.source",
      value: "system",
      viewRevision: view.revision,
    },
    key = randomUUID();
  const action = AssistantUiReceipt.parse(await call(job, "ui", input, key));
  assert.equal(AssistantUiReceipt.parse(await call(job, "ui", input, key)).id, action.id);
  const claims = await Promise.all(
    [1, 2].map(() =>
      assistant.syncUi(owner, projectId, current.id, {
        enabled: true,
        grant: false,
        clientId,
        view,
      }),
    ),
  );
  assert.equal(claims.filter((claim) => claim.action?.id === action.id).length, 1);
  assert.equal(
    AssistantUiReceipt.parse(await call(job, "ui", { operation: "result", actionId: action.id }))
      .status,
    "executing",
  );
  const updated = {
    ...view,
    revision: randomUUID(),
    targets: view.targets.map((t) => ({ ...t, value: "system" })),
  };
  await assistant.completeUi(owner, projectId, current.id, action.id, {
    clientId,
    status: "succeeded",
    message: "目录已切换",
    view: updated,
  });
  assert.equal(
    AssistantUiReceipt.parse(await call(job, "ui", { operation: "result", actionId: action.id }))
      .status,
    "succeeded",
  );
  const waiting = AssistantUiReceipt.parse(
    await call(job, "ui", { operation: "navigate", page: "tools", viewRevision: updated.revision }),
  );
  await assistant.syncUi(owner, projectId, current.id, {
    enabled: false,
    grant: false,
    clientId,
    view: updated,
  });
  assert.equal(
    AssistantUiReceipt.parse(await call(job, "ui", { operation: "result", actionId: waiting.id }))
      .status,
    "failed",
  );
  await assert.rejects(call(job, "ui", { operation: "inspect" }), { code: "UI_NOT_CONNECTED" });
  await queue.finish(job.runId, { leaseToken: job.leaseToken, status: "cancelled" });
});

test("page control cannot cross user scope or elevate viewer permissions with forged targets", async () => {
  const { actor } = await account("viewer"),
    { current, job } = await jobFor(actor);
  const clientId = randomUUID(),
    view = AssistantUiView.parse({
      revision: randomUUID(),
      page: "agents",
      targets: [{ id: "agent.name", kind: "fill", label: "名称", value: "" }],
    });
  await assistant.syncUi(actor, projectId, current.id, {
    enabled: true,
    grant: true,
    clientId,
    view,
  });
  await assert.rejects(
    assistant.syncUi(owner, projectId, current.id, { enabled: true, grant: true, clientId, view }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    call(job, "ui", {
      operation: "act",
      target: "agent.name",
      value: "forged",
      viewRevision: view.revision,
    }),
    { code: "FORBIDDEN" },
  );
  await db.query(
    "UPDATE assistant_ui_sessions SET expires_at=now()-interval '1 second' WHERE conversation_id=$1",
    [current.id],
  );
  assert.equal(
    (
      await assistant.syncUi(actor, projectId, current.id, {
        enabled: true,
        grant: false,
        clientId,
        view,
      })
    ).active,
    false,
  );
  await assert.rejects(call(job, "ui", { operation: "inspect" }), { code: "UI_NOT_CONNECTED" });
  await queue.finish(job.runId, { leaseToken: job.leaseToken, status: "cancelled" });
});

const appManifest = AgentAppManifest.parse({
  protocolVersion: "1.0",
  appId: "test.orders",
  name: "Synthetic orders",
  version: "1",
  actions: [
    {
      id: "draft.patch",
      title: "Patch",
      description: "Patch draft",
      effect: "draft",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", maxLength: 20 } },
        required: ["note"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
    },
  ],
});
const appView = () =>
  AgentAppView.parse({
    appId: appManifest.appId,
    pageSessionId: randomUUID(),
    revision: randomUUID(),
    page: { id: "orders", title: "Orders" },
    ready: true,
    summary: "Synthetic orders",
    state: { note: "" },
    actions: [{ id: "draft.patch", available: true }],
  });
test("application protocol validates grants, exact schemas, single claims, real receipt and stale pages", async () => {
  const registration = await assistant.registerApp(owner, projectId, {
    url: "https://orders.example",
    manifest: appManifest,
  });
  const { current, job } = await jobFor(),
    view = appView();
  const base = {
    registrationId: registration.id,
    clientId: randomUUID(),
    enabled: true,
    grant: false,
    allowDraft: false,
    view,
  };
  assert.equal((await assistant.syncApp(owner, projectId, current.id, base)).active, false);
  await assert.rejects(call(job, "app", { operation: "inspect" }), { code: "APP_NOT_CONNECTED" });
  await assistant.syncApp(owner, projectId, current.id, { ...base, grant: true });
  const act = {
    operation: "act",
    action: "draft.patch",
    args: { note: "safe" },
    expectedRevision: view.revision,
  };
  await assert.rejects(call(job, "app", act), { code: "DRAFT_NOT_GRANTED" });
  await assistant.syncApp(owner, projectId, current.id, { ...base, enabled: false });
  const granted = { ...base, allowDraft: true };
  await assistant.syncApp(owner, projectId, current.id, { ...granted, grant: true });
  await assert.rejects(
    assistant.syncApp(owner, projectId, current.id, {
      ...granted,
      clientId: randomUUID(),
      grant: true,
    }),
    { code: "APP_IN_USE" },
  );
  await assert.rejects(call(job, "app", { ...act, args: { note: "safe", save: true } }), {
    code: "INVALID_APP_INPUT",
  });
  await assert.rejects(call(job, "app", { ...act, expectedRevision: randomUUID() }), {
    code: "STALE_REVISION",
  });
  const key = randomUUID(),
    action = AgentAppReceipt.parse(await call(job, "app", act, key));
  assert.equal(AgentAppReceipt.parse(await call(job, "app", act, key)).id, action.id);
  await assert.rejects(call(job, "app", { ...act, args: { note: "other" } }, key), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  const claims = await Promise.all(
    [1, 2].map(() => assistant.syncApp(owner, projectId, current.id, granted)),
  );
  assert.equal(claims.filter((c) => c.action).length, 1);
  const result = {
    status: "succeeded" as const,
    output: { note: "safe" },
    message: "Updated",
    view: { ...view, revision: randomUUID(), state: { note: "safe" } },
    uiApplied: true,
    persistence: "not-requested" as const,
  };
  await assert.rejects(
    assistant.completeApp(owner, projectId, current.id, action.id, {
      clientId: randomUUID(),
      result,
    }),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    assistant.completeApp(owner, projectId, current.id, action.id, {
      clientId: base.clientId,
      result: { ...result, output: {} },
    }),
    { code: "INVALID_APP_OUTPUT" },
  );
  await assert.rejects(
    assistant.completeApp(owner, projectId, current.id, action.id, {
      clientId: base.clientId,
      result: { ...result, view: { ...result.view, pageSessionId: randomUUID() } },
    }),
    { code: "APP_SESSION_CHANGED" },
  );
  assert.equal(
    (
      await assistant.completeApp(owner, projectId, current.id, action.id, {
        clientId: base.clientId,
        result,
      })
    ).status,
    "succeeded",
  );
  const pending = AgentAppReceipt.parse(
    await call(job, "app", { ...act, expectedRevision: result.view.revision }),
  );
  await assistant.syncApp(owner, projectId, current.id, {
    ...granted,
    view: { ...result.view, revision: randomUUID() },
  });
  assert.equal(
    AgentAppReceipt.parse(await call(job, "app", { operation: "result", actionId: pending.id }))
      .status,
    "failed",
  );
  await assistant.syncApp(owner, projectId, current.id, { ...base, enabled: false });
  await queue.finish(job.runId, { leaseToken: job.leaseToken, status: "cancelled" });
  await assistant.removeApp(owner, projectId, registration.id);
});
test("application expiry is unknown after execution, cancelled before execution and cannot revive on regrant", async () => {
  const registration = await assistant.registerApp(owner, projectId, {
    url: "https://orders.example",
    manifest: appManifest,
  });
  const { current, job } = await jobFor(),
    view = appView();
  const base = {
    registrationId: registration.id,
    clientId: randomUUID(),
    enabled: true,
    grant: false,
    allowDraft: true,
    view,
  };
  await assistant.syncApp(owner, projectId, current.id, { ...base, grant: true });
  const act = {
    operation: "act",
    action: "draft.patch",
    args: { note: "safe" },
    expectedRevision: view.revision,
  };
  const key = randomUUID(),
    action = AgentAppReceipt.parse(await call(job, "app", act, key));
  await assistant.syncApp(owner, projectId, current.id, base);
  await db.query(
    "UPDATE assistant_app_sessions SET expires_at=now()-interval '1 second' WHERE conversation_id=$1",
    [current.id],
  );
  assert.equal((await assistant.syncApp(owner, projectId, current.id, base)).active, false);
  await assistant.syncApp(owner, projectId, current.id, { ...base, grant: true });
  assert.equal(AgentAppReceipt.parse(await call(job, "app", act, key)).status, "unknown");
  assert.equal(
    AgentAppReceipt.parse(await call(job, "app", { operation: "result", actionId: action.id }))
      .status,
    "unknown",
  );
  const pending = AgentAppReceipt.parse(await call(job, "app", act));
  await assistant.removeApp(owner, projectId, registration.id);
  assert.equal(
    AgentAppReceipt.parse(await call(job, "app", { operation: "result", actionId: pending.id }))
      .status,
    "cancelled",
  );
  await queue.finish(job.runId, { leaseToken: job.leaseToken, status: "cancelled" });
});
test("application ownership and project roles cannot be bypassed by a forged manifest or UI grant", async () => {
  const { actor } = await account("viewer"),
    { current, job } = await jobFor(actor),
    view = appView();
  await assert.rejects(
    assistant.registerApp(actor, projectId, {
      url: "https://orders.example",
      manifest: appManifest,
    }),
    { code: "FORBIDDEN" },
  );
  const registration = await assistant.registerApp(owner, projectId, {
    url: "https://orders.example",
    manifest: appManifest,
  });
  const base = {
    registrationId: registration.id,
    clientId: randomUUID(),
    enabled: true,
    grant: true,
    allowDraft: false,
    view,
  };
  await assert.rejects(assistant.syncApp(owner, projectId, current.id, base), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    assistant.syncApp(actor, projectId, current.id, { ...base, allowDraft: true }),
    { code: "DRAFT_NOT_GRANTED" },
  );
  await assert.rejects(
    assistant.syncApp(actor, projectId, current.id, {
      ...base,
      view: { ...view, appId: "forged.app" },
    }),
    { code: "APP_MANIFEST_CHANGED" },
  );
  await assistant.syncApp(actor, projectId, current.id, base);
  await assert.rejects(
    call(job, "app", {
      operation: "act",
      action: "draft.patch",
      args: { note: "safe" },
      expectedRevision: view.revision,
    }),
    { code: "DRAFT_NOT_GRANTED" },
  );
  await assistant.syncApp(actor, projectId, current.id, { ...base, enabled: false });
  const platformView = {
    ...view,
    appId: platformAppManifest.appId,
    state: {
      platform: {
        page: "agents",
        revision: randomUUID(),
        ready: true,
        targets: [{ id: "agent.name", label: "Name", kind: "fill", value: "" }],
      },
    },
    actions: [{ id: "agent.draft.patch", available: true }],
  };
  await assistant.syncApp(actor, projectId, current.id, {
    ...base,
    registrationId: platformAppRegistrationId,
    view: platformView,
  });
  await assert.rejects(
    call(job, "app", {
      operation: "act",
      action: "agent.draft.patch",
      args: { name: "forged" },
      expectedRevision: view.revision,
    }),
    { code: "DRAFT_NOT_GRANTED" },
  );
  await assistant.removeApp(owner, projectId, registration.id);
  await queue.finish(job.runId, { leaseToken: job.leaseToken, status: "cancelled" });
});
