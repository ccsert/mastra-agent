import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { hashPassword, sha256, Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Queue } from "../../apps/control-plane/src/modules/conversations/queue.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { Message, type Principal } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

if (!process.env.TASK_SANDBOX_IMAGE)
  console.warn(
    "[platform.test] TASK_SANDBOX_IMAGE is not set; Docker browser sandbox coverage in this file will be skipped",
  );

const schema = `test_store_${process.pid}`,
  admin = new Database(required("DATABASE_URL")),
  db = new Database(required("DATABASE_URL"), schema),
  store = new Platform(db, new Vault("ab".repeat(32)));
let actor: Principal, other: Principal;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await store.initialize();
  const ids = await store.identity.setup("test-owner", "test-password-123", "Test workspace");
  actor = {
    id: ids.userId,
    tenantId: ids.tenantId,
    displayName: "Owner",
    kind: "user",
    entry: "console",
  };
  const tenantId = randomUUID(),
    id = randomUUID();
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [tenantId, "Other"]);
  await db.query(
    "INSERT INTO users(id,tenant_id,username,display_name,password_hash) VALUES($1,$2,$3,$4,$5)",
    [id, tenantId, "other", "Other", await hashPassword("test-password-234")],
  );
  other = { id, tenantId, displayName: "Other", kind: "user", entry: "console" };
});
after(async () => {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
});
test("legacy run details and lists recover only the saved input matching that run hash", async () => {
  const project = await store.projects.create(actor, { name: "Legacy inputs", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Legacy",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Legacy");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "first exact input",
    "legacy",
  );
  await store.conversations.cancel(actor, project.id, run.id);
  // Migration 8 added input_text; earlier runs hashed only the plain text.
  await db.query("UPDATE runs SET input_text=NULL,input_hash=$2 WHERE id=$1", [
    run.id,
    sha256("first exact input"),
  ]);
  await db.query("UPDATE messages SET data=data-'metadata' WHERE conversation_id=$1", [thread.id]);
  const next = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "a different later input",
    "later",
  );
  assert.equal(
    (await store.conversations.run(actor, project.id, run.id)).inputText,
    "first exact input",
  );
  const listed = await store.conversations.runs(actor, project.id, {}, thread.id);
  assert.equal(listed.items.find((r) => r.id === run.id)?.inputText, "first exact input");
  assert.equal(listed.items.find((r) => r.id === next.id)?.inputText, "a different later input");
  await store.conversations.cancel(actor, project.id, next.id);
  const latest = await store.conversations.trace(actor, project.id, thread.id, { limit: 1 });
  assert.equal(latest.totalTurns, 2);
  assert.equal(latest.turns[0].number, 2);
  assert.equal(latest.nextBefore, 2);
  assert.equal(latest.initial?.run.inputText, "first exact input");
  const first = await store.conversations.trace(actor, project.id, thread.id, {
    before: 2,
    limit: 1,
  });
  assert.equal(first.turns[0].run.id, run.id);
  assert.equal(first.turns[0].number, 1);
  assert.equal(first.nextBefore, null);
  const summaries = await store.conversations.summaries(actor, project.id);
  assert.equal(summaries.items.length, 1);
  assert.equal(summaries.items[0].runCount, 2);
  assert.equal(summaries.items[0].latestRunId, next.id);
  await assert.rejects(
    () => store.conversations.trace({ ...actor, id: randomUUID() }, project.id, thread.id),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    () => store.conversations.trace({ ...actor, entry: "sdk" }, project.id, thread.id),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(() => store.conversations.trace(other, project.id, thread.id), {
    code: "NOT_FOUND",
  });
  await db.query(
    "INSERT INTO run_events(run_id,seq,chunk) SELECT $1,n,jsonb_build_object('type','text-delta','delta','x','id','txt-0') FROM generate_series(0,505) n",
    [run.id],
  );
  const partial = await store.conversations.trace(actor, project.id, thread.id, { before: 2 });
  // Consecutive same-id deltas merge into one chunk; raw cursor reads stay intact.
  assert.equal(partial.turns[0].events.length, 1);
  const merged = partial.turns[0].events[0]?.chunk as { delta?: string } | undefined;
  assert.equal((merged?.delta ?? "").length, 501);
  assert.equal(partial.turns[0].hasMoreEvents, true);
  assert.equal((await store.conversations.events(actor, project.id, run.id, 499)).length, 6);
  await assert.rejects(() => store.conversations.run(other, project.id, run.id), {
    code: "NOT_FOUND",
  });
  const [stored] = await db.query("SELECT input_text FROM runs WHERE id=$1", [run.id]);
  assert.equal(stored.input_text, null);
  await db.query("UPDATE runs SET input_hash=$2 WHERE id=$1", [
    run.id,
    sha256("missing historical message"),
  ]);
  assert.equal((await store.conversations.run(actor, project.id, run.id)).inputText, null);
});
test("conversations derive a copy up to a message without rerunning", async () => {
  const project = await store.projects.create(actor, { name: "Derive", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Derive",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Derive");
  const run = await store.conversations.createRun(actor, project.id, thread.id, "input", "derive");
  await store.conversations.cancel(actor, project.id, run.id);
  const [message] = await db.query(
    "SELECT id FROM messages WHERE conversation_id=$1 ORDER BY position DESC LIMIT 1",
    [thread.id],
  );
  const derived = await store.conversations.derive(actor, project.id, thread.id, {
    upToMessageId: String(message.id),
    requestId: "derive-1",
  });
  assert.equal(derived.parentConversationId, thread.id);
  assert.ok(derived.title.includes("派生"));
  const [copied] = await db.query(
    "SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1",
    [derived.id],
  );
  assert.ok(Number(copied.n) >= 1);
  const repeated = await store.conversations.derive(actor, project.id, thread.id, {
    upToMessageId: String(message.id),
    requestId: "derive-1",
  });
  assert.equal(repeated.id, derived.id);
  await assert.rejects(
    () =>
      store.conversations.derive(other, project.id, thread.id, {
        upToMessageId: String(message.id),
        requestId: "derive-other",
      }),
    { code: "NOT_FOUND" },
  );
});
test("conversation pins and titles update in place and stay scoped to their owner", async () => {
  const project = await store.projects.create(actor, {
    name: "Conversation pins",
    description: "",
  });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Pins",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Pins");
  const run = await store.conversations.createRun(actor, project.id, thread.id, "input", "pins");
  await store.conversations.cancel(actor, project.id, run.id);
  const renamed = await store.conversations.update(actor, project.id, thread.id, {
    title: "采购复盘",
  });
  assert.equal(renamed.title, "采购复盘");
  const pinned = await store.conversations.update(actor, project.id, thread.id, { pinned: true });
  assert.ok(pinned.pinnedAt);
  const pinnedPage = await store.conversations.list(
    actor,
    project.id,
    { limit: 10 },
    { pinned: true },
  );
  assert.deepEqual(
    pinnedPage.items.map((c) => [c.id, c.pinnedAt !== null]),
    [[thread.id, true]],
  );
  const unpinned = await store.conversations.update(actor, project.id, thread.id, {
    pinned: false,
  });
  assert.equal(unpinned.pinnedAt, null);
  const emptied = await store.conversations.list(
    actor,
    project.id,
    { limit: 10 },
    { pinned: true },
  );
  assert.deepEqual(emptied.items, []);
  await assert.rejects(
    () => store.conversations.update(other, project.id, thread.id, { pinned: true }),
    { code: "NOT_FOUND" },
  );
});
test("runs auto-compact when the last measured context exceeds the agent window", async () => {
  const project = await store.projects.create(actor, { name: "Auto compact", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "AutoCompact",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "AutoCompact");
  const first = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "第一次提问",
    "auto-1",
  );
  await store.conversations.cancel(actor, project.id, first.id);
  await db.query("INSERT INTO run_events(run_id,seq,chunk) VALUES($1,0,$2)", [
    first.id,
    JSON.stringify({
      type: "data-model-step",
      data: {
        usage: { inputTokens: 1000 },
        stepIndex: 0,
        completedAt: "2026-09-15T00:00:00Z",
        finishReason: "stop",
      },
    }),
  ]);
  const normal = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "第二次提问",
    "auto-2",
  );
  await store.conversations.cancel(actor, project.id, normal.id);
  const [normalRow] = await db.query("SELECT context_action FROM runs WHERE id=$1", [normal.id]);
  assert.equal(normalRow.context_action, null);
  // Usage above 75% of the default 32000-token window flips the next run to compaction.
  await db.query("UPDATE run_events SET chunk=$2 WHERE run_id=$1 AND seq=0", [
    first.id,
    JSON.stringify({
      type: "data-model-step",
      data: {
        usage: { inputTokens: 25000 },
        stepIndex: 0,
        completedAt: "2026-09-15T00:00:00Z",
        finishReason: "stop",
      },
    }),
  ]);
  const auto = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "第三次提问",
    "auto-3",
  );
  const [autoRow] = await db.query("SELECT context_action FROM runs WHERE id=$1", [auto.id]);
  assert.equal(autoRow.context_action, "compact");
  // Occupancy projection: estimated tokens for the current model view.
  const projected = await store.conversations.context(actor, project.id, thread.id);
  assert.ok((projected.contextTokens ?? 0) >= 1);
  assert.equal(projected.contextWindow, 32000);
  // Leave no queued run behind: later tests claim the next queued run.
  await store.conversations.cancel(actor, project.id, auto.id);
  await assert.rejects(
    () => store.conversations.createRun(other, project.id, thread.id, "越权提问", "auto-other"),
    { code: "NOT_FOUND" },
  );
});
test("runtime registry issues credentials and enforces lifecycle", async () => {
  const name = `边缘 Runtime ${randomUUID().slice(0, 8)}`;
  const registered = await store.runtimes.register(actor, { name });
  assert.equal(registered.name, name);
  assert.ok(registered.token.length >= 32);
  // Issued credentials authenticate; wrong ones do not.
  assert.equal(await store.runtimes.authenticate(registered.id, registered.token), true);
  assert.equal(await store.runtimes.authenticate(registered.id, "wrong"), false);
  assert.equal(await store.runtimes.authenticate("no-such-runtime", registered.token), false);
  // Disabling revokes authentication without deleting the registration.
  await store.runtimes.update(actor, registered.id, { enabled: false });
  assert.equal(await store.runtimes.authenticate(registered.id, registered.token), false);
  await store.runtimes.update(actor, registered.id, { enabled: true });
  assert.equal(await store.runtimes.authenticate(registered.id, registered.token), true);
  // Rename keeps authentication intact.
  await store.runtimes.update(actor, registered.id, { name: "边缘 Runtime 改名" });
  assert.equal(await store.runtimes.authenticate(registered.id, registered.token), true);
  // The built-in runtime cannot be deleted or disabled.
  await assert.rejects(() => store.runtimes.delete(actor, "hosted-local"), {
    code: "RUNTIME_BUILT_IN",
  });
  await assert.rejects(() => store.runtimes.update(actor, "hosted-local", { enabled: false }), {
    code: "RUNTIME_BUILT_IN",
  });
  // Cross-tenant admins cannot see or manage it.
  await assert.rejects(() => store.runtimes.delete(other, registered.id), { code: "FORBIDDEN" });
  // Deletion removes authentication.
  await store.runtimes.delete(actor, registered.id);
  assert.equal(await store.runtimes.authenticate(registered.id, registered.token), false);
  const listed = await store.runtimes.list(actor);
  assert.ok(!listed.some((r) => r.id === registered.id));
});
test("published revisions and conversation ownership are durable, secrets never enter public snapshots", async () => {
  const project = await store.projects.create(actor, { name: "Orders", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Development",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "sensitive-test-key",
  });
  assert.equal(model.hasCredential, true);
  assert.ok(!JSON.stringify(model).includes("sensitive-test-key"));
  const agent = await store.agents.create(actor, project.id, {
    name: "Orders agent",
    description: "",
    instructions: "Version one",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  const v1 = await store.agents.publish(actor, project.id, agent.id, 1);
  assert.equal(v1.version, 1);
  assert.ok(!JSON.stringify(v1).includes("sensitive-test-key"));
  const thread = await store.conversations.create(actor, project.id, agent.id, "First");
  const updated = await store.agents.update(
    actor,
    project.id,
    agent.id,
    {
      name: agent.name,
      description: "",
      instructions: "Version two",
      modelId: model.id,
      toolIds: [],
      maxSteps: 3,
    },
    1,
  );
  await assert.rejects(() => store.agents.publish(actor, project.id, agent.id, 1), {
    code: "DRAFT_CONFLICT",
  });
  const v2 = await store.agents.publish(actor, project.id, agent.id, updated.draftRevision);
  assert.equal(v2.version, 2);
  assert.notEqual(v1.digest, v2.digest);
  assert.equal((await store.conversations.get(actor, project.id, thread.id)).releaseId, v1.id);
  assert.equal(
    (await store.agents.releases(actor, project.id, agent.id))[1].snapshot.agent.instructions,
    "Version one",
  );
  await assert.rejects(() => store.projects.get(other, project.id), { code: "NOT_FOUND" });
  const otherUser = { ...actor, id: randomUUID() };
  await assert.rejects(() => store.conversations.messages(otherUser, project.id, thread.id), {
    code: "NOT_FOUND",
  });
  const run = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "Hello",
    "request-1",
  );
  assert.equal(run.releaseId, v1.id);
  assert.equal(
    (await store.conversations.createRun(actor, project.id, thread.id, "Hello", "request-1")).id,
    run.id,
  );
  await assert.rejects(
    () => store.conversations.createRun(actor, project.id, thread.id, "Changed", "request-1"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    () => store.conversations.createRun(actor, project.id, thread.id, "Next", "request-2"),
    {
      code: "CONVERSATION_BUSY",
    },
  );
  assert.equal((await store.conversations.cancel(actor, project.id, run.id)).status, "cancelled");
  const reconnect = new Database(required("DATABASE_URL"), schema);
  try {
    const reopened = new Platform(reconnect, store.vault);
    assert.equal((await reopened.conversations.messages(actor, project.id, thread.id)).length, 1);
    assert.equal((await reopened.conversations.runs(actor, project.id)).items.length, 1);
  } finally {
    await reconnect.close();
  }
});

test("blank sessions are reused, hidden until used, named by the first message and deletable", async () => {
  const project = await store.projects.create(actor, { name: "Sessions", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Sessions agent",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const first = await store.conversations.create(actor, project.id, agent.id, "新会话");
  const second = await store.conversations.create(actor, project.id, agent.id, "新会话");
  // Repeated "对话" reuses the unused placeholder instead of piling up empty sessions.
  assert.equal(second.id, first.id);
  // Reuse adopts the freshly requested title, including for legacy named empties.
  const renamed = await store.conversations.create(actor, project.id, agent.id, "复用后的标题");
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.title, "复用后的标题");
  await store.conversations.create(actor, project.id, agent.id, "新会话");
  // A run-less placeholder is not listed.
  assert.equal((await store.conversations.list(actor, project.id)).items.length, 0);
  const run = await store.conversations.createRun(
    actor,
    project.id,
    first.id,
    "汇总本周订单情况",
    "session-1",
  );
  await store.conversations.cancel(actor, project.id, run.id);
  // The first message names the session, and it now appears in the list.
  assert.equal(
    (await store.conversations.get(actor, project.id, first.id)).title,
    "汇总本周订单情况",
  );
  const listed = (await store.conversations.list(actor, project.id)).items;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, first.id);
  // Once named by a run, a fresh placeholder is created rather than reusing it.
  const third = await store.conversations.create(actor, project.id, agent.id, "新会话");
  assert.notEqual(third.id, first.id);
  // Deleting removes the session, its messages and its runs.
  await store.conversations.remove(actor, project.id, first.id);
  await assert.rejects(() => store.conversations.get(actor, project.id, first.id), {
    code: "NOT_FOUND",
  });
  await assert.rejects(() => store.conversations.messages(actor, project.id, first.id), {
    code: "NOT_FOUND",
  });
  assert.equal((await store.conversations.list(actor, project.id)).items.length, 0);
});
test("leases fence late workers, events are ordered and deduplicated, failed jobs are not replayed", async () => {
  const project = await store.projects.create(actor, { name: "Lease tests", description: "" });
  const foreign = await store.projects.create(actor, { name: "Foreign project", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  await assert.rejects(
    () =>
      store.agents.create(actor, foreign.id, {
        name: "Foreign",
        description: "",
        instructions: "Test",
        modelId: model.id,
        toolIds: [],
        maxSteps: 3,
      }),
    { code: "NOT_FOUND" },
  );
  const agent = await store.agents.create(actor, project.id, {
    name: "Lease agent",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  const releases = await Promise.all([
    store.agents.publish(actor, project.id, agent.id, 1),
    store.agents.publish(actor, project.id, agent.id, 1),
  ]);
  assert.equal(releases[0].id, releases[1].id);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Lease");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "Hello",
    "lease-test",
  );
  const queue = new Queue(db, store.vault, "hosted-local"),
    job = await queue.claim();
  assert.equal(job?.runId, run.id);
  assert.ok(job);
  const start = { type: "start", messageId: "assistant" };
  const occurredAt = "2026-09-11T03:00:00.000Z";
  await queue.append(run.id, { leaseToken: job.leaseToken, seq: 0, occurredAt, chunk: start });
  await queue.append(run.id, { leaseToken: job.leaseToken, seq: 0, chunk: start });
  await assert.rejects(
    () =>
      queue.append(run.id, {
        leaseToken: job.leaseToken,
        seq: 0,
        chunk: { type: "start", messageId: "different" },
      }),
    { code: "EVENT_CONFLICT" },
  );
  await assert.rejects(
    () =>
      queue.append(run.id, {
        leaseToken: job.leaseToken,
        seq: 2,
        chunk: { type: "text-start", id: "text" },
      }),
    { code: "EVENT_SEQUENCE" },
  );
  await assert.rejects(
    () =>
      queue.append(run.id, {
        leaseToken: job.leaseToken,
        seq: 1,
        chunk: { type: "not-a-chunk" },
      }),
    { code: "INVALID_EVENT" },
  );
  // A runtime-reported time is kept as such; an event that never carried one keeps
  // the receipt time and says so rather than being recomputed.
  await queue.append(run.id, {
    leaseToken: job.leaseToken,
    seq: 1,
    chunk: { type: "text-start", id: "text" },
  });
  const [turn] = (await store.conversations.trace(actor, project.id, thread.id)).turns;
  assert.equal(turn?.events[0]?.occurredAt, occurredAt);
  assert.equal(turn?.events[0]?.timeSource, "runtime");
  assert.equal(turn?.events[1]?.timeSource, "control-plane");
  assert.equal(turn?.events[1]?.occurredAt, turn?.events[1]?.createdAt);
  await assert.rejects(() => queue.renew(run.id, randomUUID()), { code: "LEASE_EXPIRED" });
  await db.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id]);
  await queue.reap();
  assert.equal(
    (await store.conversations.run(actor, project.id, run.id)).errorCode,
    "RUNTIME_LOST",
  );
  assert.equal(await queue.claim(), null);
  await assert.rejects(
    () =>
      queue.finish(run.id, {
        leaseToken: job.leaseToken,
        status: "succeeded",
        message: { id: "late", role: "assistant", parts: [{ type: "text", text: "Late output" }] },
      }),
    { code: "LEASE_EXPIRED" },
  );
  assert.equal(
    (await store.conversations.createRun(actor, project.id, thread.id, "Hello", "lease-test")).id,
    run.id,
  );
  assert.equal((await store.conversations.messages(actor, project.id, thread.id)).length, 1);
});

test("chat drains committed tail events when completion races an event poll", async () => {
  const project = await store.projects.create(actor, { name: "Stream race", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Race",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Race",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Race");
  const token = await store.identity.login("test-owner", "test-password-123");
  const { app, queue } = createApp(store, {
    origin: "http://127.0.0.1:5173",
    runtimeToken: "test-token",
  });
  const originalEvents = store.conversations.events.bind(store.conversations);
  let completed = false;
  store.conversations.events = async (...args) => {
    const polled = await originalEvents(...args);
    if (!completed) {
      completed = true;
      const job = await queue.claim();
      assert.ok(job);
      const chunks = [
        { type: "start", messageId: "race" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "tail-marker" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop" },
      ];
      for (const [seq, chunk] of chunks.entries())
        await queue.append(job.runId, {
          leaseToken: job.leaseToken,
          seq,
          occurredAt: new Date().toISOString(),
          chunk,
        });
      await queue.finish(job.runId, {
        leaseToken: job.leaseToken,
        status: "succeeded",
        message: { id: "race", role: "assistant", parts: [{ type: "text", text: "tail-marker" }] },
      });
    }
    return polled;
  };
  try {
    const response = await app.request(
      `/api/v1/projects/${project.id}/conversations/${thread.id}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `platform_session=${token}` },
        body: JSON.stringify({
          messages: [{ id: "race-request", role: "user", parts: [{ type: "text", text: "Run" }] }],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(body.includes("tail-marker"), body);
    assert.ok(body.includes('"type":"finish"'), body);
  } finally {
    store.conversations.events = originalEvents;
  }
});

test("resource invariants apply to in-process calls and authenticated responses cannot be cached", async () => {
  const project = await store.projects.create(actor, {
    name: "Resource boundaries",
    description: "",
  });
  await assert.rejects(
    () =>
      store.resources.createModel(actor, project.id, {
        name: "Invalid",
        baseUrl: "http://user:password@model.test/v1",
        modelId: "model",
      }),
    { code: "INVALID_ENDPOINT" },
  );
  const input = {
    name: "sum_boundary",
    description: "Total",
    kind: "sum" as const,
    url: "",
    bearerToken: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };
  const tool = await store.resources.createTool(actor, project.id, input);
  assert.deepEqual(tool.inputSchema.required, ["values"]);
  assert.deepEqual(tool.outputSchema.required, ["total"]);
  assert.deepEqual(
    input.inputSchema,
    { type: "object" },
    "Domain operations do not mutate caller data",
  );
  const { app } = createApp(store, {
    origin: "http://console.test",
    runtimeToken: "test-runtime-token",
  });
  const token = await store.identity.login("test-owner", "test-password-123");
  const response = await app.request(`/api/v1/projects/${project.id}/tools`, {
    headers: { cookie: `platform_session=${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const tools = await response.json();
  assert.deepEqual(tools[0].inputSchema, tool.inputSchema);
});

test("detaching and reopening a run replays every committed event without executing twice and downloads only owned recorded results", async () => {
  const project = await store.projects.create(actor, { name: "Continuity", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Recovery",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Recovery");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "Generate results",
    "one-request",
  );
  const session = await store.conversations.session(actor, project.id, thread.id);
  assert.equal(session.messages.length, 1);
  assert.equal(session.resumeRun?.id, run.id);
  const token = await store.identity.login("test-owner", "test-password-123");
  const { app, queue } = createApp(store, {
    origin: "http://127.0.0.1:5173",
    runtimeToken: "test-token",
  });
  const headers = { cookie: `platform_session=${token}` };
  const url = `/api/v1/projects/${project.id}/conversations/${thread.id}/stream?runId=${run.id}`;
  const detached = await app.request(url, { headers });
  assert.equal(detached.headers.get("x-resumable-stream-id"), run.id);
  const reader = detached.body?.getReader();
  assert.ok(reader);
  assert.match(new TextDecoder().decode((await reader.read()).value), /assistant-/);
  await reader.cancel();
  const job = await queue.claim();
  assert.ok(job);
  assert.equal(job.runId, run.id);
  const chunks = [
    { type: "start", messageId: "upstream-id" },
    {
      type: "tool-input-available",
      toolCallId: "result-call",
      toolName: "table_report",
      input: {},
    },
    {
      type: "tool-output-available",
      toolCallId: "result-call",
      output: [
        { order: "A", amount: 10 },
        { order: "=unsafe()", amount: 20 },
      ],
    },
    { type: "text-start", id: "text" },
    ...Array.from({ length: 505 }, () => ({ type: "text-delta", id: "text", delta: "x" })),
    { type: "text-end", id: "text" },
    { type: "finish", finishReason: "stop" },
  ];
  for (const [seq, chunk] of chunks.entries())
    await queue.append(run.id, { leaseToken: job.leaseToken, seq, chunk });
  await queue.finish(run.id, {
    leaseToken: job.leaseToken,
    status: "succeeded",
    message: {
      id: "upstream-id",
      role: "assistant",
      parts: [{ type: "text", text: "x".repeat(505) }],
    },
  });
  const settled = await store.conversations.session(actor, project.id, thread.id);
  assert.equal(settled.messages.length, 2);
  assert.equal(settled.resumeRun, null);
  const replay = await app.request(url, { headers });
  const wire = await replay.text();
  assert.equal((wire.match(/"type":"text-delta"/g) ?? []).length, 505);
  assert.equal((wire.match(/"type":"start"/g) ?? []).length, 1);
  assert.equal((wire.match(/"type":"finish"/g) ?? []).length, 1);
  assert.ok(wire.includes(`assistant-${run.id}`));
  assert.equal((await store.conversations.runs(actor, project.id, {}, thread.id)).items.length, 1);
  const workspace = (await store.conversations.workspace(actor, project.id, run.id)).workspace;
  assert.equal(workspace.artifacts.length, 2);
  const csv = workspace.artifacts.find((f) => f.id.endsWith("-csv"));
  assert.ok(csv);
  const download = await app.request(
    `/api/v1/projects/${project.id}/runs/${run.id}/artifacts/${csv.id}`,
    { headers },
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  const content = await download.text();
  assert.ok(content.includes("'=unsafe()"));
  assert.equal(sha256(content), csv.sha256);
  await assert.rejects(
    () => store.conversations.workspace({ ...actor, id: randomUUID() }, project.id, run.id),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    () => store.conversations.session({ ...actor, entry: "sdk" }, project.id, thread.id),
    { code: "NOT_FOUND" },
  );
  const otherThread = await store.conversations.create(actor, project.id, agent.id, "Other");
  assert.equal(
    (
      await app.request(
        `/api/v1/projects/${project.id}/conversations/${otherThread.id}/stream?runId=${run.id}`,
        { headers },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/api/v1/projects/${project.id}/runs/${run.id}/artifacts/999-json`, {
        headers,
      })
    ).status,
    404,
  );
  const cancelled = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "Interrupted input",
    "interrupted",
  );
  const interrupted = await queue.claim();
  assert.ok(interrupted);
  assert.equal(interrupted.runId, cancelled.id);
  for (const [seq, chunk] of [
    { type: "start", messageId: "partial" },
    { type: "text-start", id: "partial-text" },
    { type: "text-delta", id: "partial-text", delta: "这部分已经执行" },
  ].entries())
    await queue.append(cancelled.id, { leaseToken: interrupted.leaseToken, seq, chunk });
  await queue.finish(cancelled.id, {
    leaseToken: interrupted.leaseToken,
    status: "cancelled",
    errorCode: "CANCELLED",
  });
  const later = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "Continue afterwards",
    "later",
  );
  const restored = await store.conversations.session(actor, project.id, thread.id);
  assert.equal(restored.resumeRun?.id, later.id);
  assert.deepEqual(
    restored.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  assert.equal(restored.messages[3].parts[0].text, "这部分已经执行");
  assert.equal(restored.messages[3].metadata?.runStatus, "cancelled");
  await store.conversations.cancel(actor, project.id, later.id);
});

test("editing branches only saved prior context, preserves the source and is idempotent", async () => {
  const project = await store.projects.create(actor, { name: "Editable chat", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Editable",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const source = await store.conversations.create(actor, project.id, agent.id, "Original");
  const first = await store.conversations.createRun(
    actor,
    project.id,
    source.id,
    "first",
    "live-first",
  );
  await store.conversations.cancel(actor, project.id, first.id);
  for (const [seq, chunk] of [
    { type: "start", messageId: "first-answer" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "已有检查结果" },
  ].entries())
    await db.query("INSERT INTO run_events(run_id,seq,chunk) VALUES($1,$2,$3)", [
      first.id,
      seq,
      chunk,
    ]);
  const second = await store.conversations.createRun(
    actor,
    project.id,
    source.id,
    "second",
    "live-second",
  );
  await assert.rejects(
    store.conversations.edit(actor, project.id, source.id, {
      messageId: "live-second",
      input: "revised",
      requestId: "edit-busy",
    }),
    /请等待/,
  );
  await store.conversations.cancel(actor, project.id, second.id);
  const tail = await store.conversations.createRun(
    actor,
    project.id,
    source.id,
    "future must be excluded",
    "future",
  );
  await store.conversations.cancel(actor, project.id, tail.id);
  const before = await store.conversations.messages(actor, project.id, source.id);
  const input = { messageId: "live-second", input: "revised", requestId: "edit-request" };
  const branch = await store.conversations.edit(actor, project.id, source.id, input);
  assert.equal(branch.parentConversationId, source.id);
  assert.equal(branch.releaseId, source.releaseId);
  assert.deepEqual(await store.conversations.messages(actor, project.id, source.id), before);
  const messages = await store.conversations.messages(actor, project.id, branch.id);
  assert.deepEqual(
    messages.map((m) => Message.parse(m).parts[0].text),
    ["first", "已有检查结果", "revised"],
  );
  assert.equal(Message.parse(messages[1]).metadata?.originConversationId, source.id);
  assert.equal(Message.parse(messages[1]).metadata?.runStatus, "cancelled");
  assert.equal((await store.conversations.edit(actor, project.id, source.id, input)).id, branch.id);
  assert.equal((await store.conversations.runs(actor, project.id, {}, branch.id)).items.length, 1);
  await assert.rejects(
    store.conversations.edit(actor, project.id, source.id, { ...input, input: "different" }),
    /请求标识/,
  );
  await assert.rejects(store.conversations.edit(other, project.id, source.id, input));
  await assert.rejects(
    store.conversations.edit(actor, project.id, source.id, {
      ...input,
      messageId: "unknown",
      requestId: "other",
    }),
  );
});

test("long task budgets, string tool receipts and recovery remain scoped to the current lease", async () => {
  const project = await store.projects.create(actor, {
    name: "Long task invariants",
    description: "",
  });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Long",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 80,
    executionLimits: { maxModelCalls: 2, maxTokens: 1000 },
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const conversation = await store.conversations.create(actor, project.id, agent.id, "Long");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    conversation.id,
    "Test",
    "long",
  );
  await db.query("INSERT INTO runtimes(id,name) VALUES($1,$2)", [
    "long-task-test",
    "Long task test",
  ]);
  await db.query("UPDATE runs SET runtime_id=$1 WHERE id=$2", ["long-task-test", run.id]);
  const queue = new Queue(db, store.vault, "long-task-test");
  const job = await queue.claim();
  assert.equal(job?.runId, run.id);
  assert.ok(job);
  const leaseToken = job.leaseToken;
  const progress = {
    baseRevision: 0,
    objective: "Test persistent progress",
    constraints: [],
    progress: "started",
    nextSteps: ["verify"],
    evidence: [],
    status: "in_progress" as const,
  };
  const saved = await queue.task(run.id, { leaseToken, operation: "state", state: progress });
  assert.deepEqual(
    await queue.task(run.id, { leaseToken, operation: "state", state: progress }),
    saved,
  );
  await assert.rejects(
    queue.task(run.id, {
      leaseToken,
      operation: "state",
      state: { ...progress, baseRevision: 1, status: "completed" },
    }),
    { code: "ACCEPTANCE_EVIDENCE_REQUIRED" },
  );

  await queue.task(run.id, {
    leaseToken,
    operation: "reserve",
    requestId: "first",
    estimatedTokens: 800,
  });
  await queue.task(run.id, {
    leaseToken,
    operation: "reserve",
    requestId: "first",
    estimatedTokens: 800,
  });
  await assert.rejects(
    queue.task(run.id, {
      leaseToken,
      operation: "reserve",
      requestId: "second",
      estimatedTokens: 800,
    }),
    { code: "TOKEN_BUDGET" },
  );
  await queue.task(run.id, {
    leaseToken,
    operation: "settle",
    requestId: "first",
    actualTokens: 50,
  });
  await queue.task(run.id, {
    leaseToken,
    operation: "settle",
    requestId: "first",
    actualTokens: 50,
  });
  await assert.rejects(
    queue.task(run.id, { leaseToken, operation: "settle", requestId: "first", actualTokens: 51 }),
    { code: "EVENT_CONFLICT" },
  );
  await queue.task(run.id, {
    leaseToken,
    operation: "reserve",
    requestId: "second",
    estimatedTokens: 800,
  });
  await assert.rejects(
    queue.task(run.id, {
      leaseToken,
      operation: "reserve",
      requestId: "third",
      estimatedTokens: 1,
    }),
    { code: "MODEL_CALL_LIMIT" },
  );
  const receipt = {
    leaseToken,
    operation: "tool-start" as const,
    callId: "write",
    inputHash: "a".repeat(64),
  };
  assert.deepEqual(await queue.task(run.id, receipt), { cached: false });
  await assert.rejects(queue.task(run.id, receipt), { code: "TOOL_OUTCOME_UNKNOWN" });
  await queue.task(run.id, {
    leaseToken,
    operation: "tool-finish",
    callId: "write",
    output: 'Written "index.html"\n',
  });
  assert.deepEqual(await queue.task(run.id, receipt), {
    cached: true,
    output: 'Written "index.html"\n',
    errorCode: null,
  });
  await queue.task(run.id, {
    leaseToken,
    operation: "save",
    workflowName: "durable-agentic-loop",
    snapshot: { runId: run.id, status: "running" },
  });
  await db.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id]);
  await queue.reap();
  const resumed = await queue.claim();
  assert.equal(resumed?.runId, run.id);
  assert.equal(resumed?.recoveryCount, 1);
  assert.ok(resumed);
  await assert.rejects(
    queue.task(run.id, { leaseToken, operation: "load", workflowName: "durable-agentic-loop" }),
    { code: "LEASE_EXPIRED" },
  );
  await assert.rejects(
    queue.task(run.id, {
      leaseToken: resumed.leaseToken,
      operation: "reserve",
      requestId: "after-recovery",
      estimatedTokens: 1,
    }),
    { code: "MODEL_CALL_LIMIT" },
  );
  await queue.task(run.id, { ...receipt, leaseToken: resumed.leaseToken, callId: "uncertain" });
  await db.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id]);
  await queue.reap();
  const [ended] = await db.query("SELECT status,error_code FROM runs WHERE id=$1", [run.id]);
  assert.deepEqual(ended, { status: "failed", error_code: "TOOL_OUTCOME_UNKNOWN" });
  const continuation = await store.conversations.createRun(
    actor,
    project.id,
    conversation.id,
    "Continue",
    "continuation",
  );
  await db.query("UPDATE runs SET runtime_id=$1 WHERE id=$2", ["long-task-test", continuation.id]);
  const next = await queue.claim();
  assert.ok(next);
  assert.equal(next.runId, continuation.id);
  const history = (await queue.task(next.runId, {
    leaseToken: next.leaseToken,
    operation: "history",
  })) as { runs: Array<{ runId: string; status: string }> };
  assert.deepEqual(
    history.runs.map((r) => ({ id: r.runId, status: r.status })),
    [{ id: run.id, status: "failed" }],
  );
  const [foreign] = await db.query("SELECT id FROM runs WHERE conversation_id<>$1 LIMIT 1", [
    conversation.id,
  ]);
  assert.ok(foreign);
  const denied = (await queue.task(next.runId, {
    leaseToken: next.leaseToken,
    operation: "history",
    runId: String(foreign.id),
  })) as { runs: unknown[] };
  assert.deepEqual(denied.runs, []);
  await queue.finish(next.runId, {
    leaseToken: next.leaseToken,
    status: "failed",
    errorCode: "CANCELLED",
  });
});

test("80 user turns preserve durable conversation history and the original constraint through context trimming", {
  timeout: 60000,
}, async () => {
  const { startModelFixture } = await import("../fixtures/model-fixture.ts");
  const { executeJob } = await import("../../apps/runtime/src/agents/execute.ts");
  const fixture = await startModelFixture(0, {
    toolSequence: [],
    answer: "Recorded fixture feedback.",
  });
  try {
    const project = await store.projects.create(actor, { name: "80 user turns", description: "" });
    const model = await store.resources.createModel(actor, project.id, {
      name: "Protocol fixture",
      baseUrl: `${fixture.url}/v1`,
      modelId: "fixture",
      apiKey: "fixture-key",
    });
    const agent = await store.agents.create(actor, project.id, {
      name: "Conversation endurance",
      instructions: "Keep the original requirement",
      modelId: model.id,
      toolIds: [],
      maxSteps: 1,
      executionLimits: { contextTokens: 4000 },
    });
    await store.agents.publish(actor, project.id, agent.id, 1);
    const conversation = await store.conversations.create(
      actor,
      project.id,
      agent.id,
      "80 user turns",
    );
    await db.query("INSERT INTO runtimes(id,name) VALUES('turn-test','User turn fixture')");
    const queue = new Queue(db, store.vault, "turn-test");
    let trims = 0;
    for (let turn = 1; turn <= 80; turn++) {
      const run = await store.conversations.createRun(
        actor,
        project.id,
        conversation.id,
        turn === 1
          ? "Keep title violet-317."
          : `Feedback ${turn}: ${"Detailed revision for the current page. ".repeat(30)}`,
        `turn-${turn}`,
      );
      await db.query("UPDATE runs SET runtime_id='turn-test' WHERE id=$1", [run.id]);
      const job = await queue.claim();
      assert.ok(job);
      assert.equal(job.runId, run.id);
      assert.equal(job.messages.filter((m) => m.role === "user").length, turn);
      let seq = 0;
      let delivery = Promise.resolve();
      const message = await executeJob(job, AbortSignal.timeout(10000), async (chunk) => {
        if (chunk.type === "data-context-trim") trims++;
        delivery = delivery.then(() =>
          queue.append(run.id, { leaseToken: job.leaseToken, seq: seq++, chunk }),
        );
        await delivery;
      });
      await delivery;
      await queue.finish(run.id, {
        leaseToken: job.leaseToken,
        status: "succeeded",
        message: Message.parse(message),
      });
    }
    assert.equal(fixture.calls, 80);
    assert.ok(trims > 0);
    assert.ok(fixture.systemPrompts.every((prompt) => prompt.includes("violet-317")));
    const session = await store.conversations.session(actor, project.id, conversation.id);
    assert.equal(session.messages.length, 160);
    assert.equal(session.resumeRun, null);
    const latest = await store.conversations.trace(actor, project.id, conversation.id, {
      limit: 10,
    });
    assert.equal(latest.totalTurns, 80);
    assert.equal(latest.turns.at(-1)?.number, 80);
    const first = await store.conversations.trace(actor, project.id, conversation.id, {
      before: 11,
      limit: 10,
    });
    assert.equal(first.turns[0].number, 1);
    assert.equal(first.turns[0].run.inputText, "Keep title violet-317.");
  } finally {
    await fixture.close();
  }
});

test("feedback is owned, idempotent, lease-fenced and remains available after a new turn", async () => {
  const project = await store.projects.create(actor, { name: "Feedback", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "fixture",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Feedback",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const conversation = await store.conversations.create(actor, project.id, agent.id, "Feedback");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    conversation.id,
    "First",
    "first",
  );
  const input = { requestId: "feedback-1", text: "Use cobalt-492" };
  await assert.rejects(store.conversations.feedback(other, project.id, run.id, input), {
    code: "NOT_FOUND",
  });
  const first = await store.conversations.feedback(actor, project.id, run.id, input);
  assert.deepEqual(await store.conversations.feedback(actor, project.id, run.id, input), first);
  await assert.rejects(
    store.conversations.feedback(actor, project.id, run.id, { ...input, text: "Changed" }),
    { code: "EVENT_CONFLICT" },
  );
  await db.query("INSERT INTO runtimes(id,name) VALUES('feedback-test','Feedback test')");
  await db.query("UPDATE runs SET runtime_id='feedback-test' WHERE id=$1", [run.id]);
  const queue = new Queue(db, store.vault, "feedback-test");
  const job = await queue.claim();
  assert.ok(job);
  const read = () =>
    queue.task(run.id, { leaseToken: job.leaseToken, operation: "feedback" }) as Promise<{
      feedback: { id: string; text: string; readAt: string | null }[];
    }>;
  assert.equal((await read()).feedback[0].readAt, null);
  await queue.task(run.id, {
    leaseToken: job.leaseToken,
    operation: "feedback-read",
    ids: [first.id, randomUUID()],
  });
  assert.ok((await read()).feedback[0].readAt);
  await assert.rejects(queue.task(run.id, { leaseToken: "wrong", operation: "feedback" }), {
    code: "LEASE_EXPIRED",
  });
  for (let n = 2; n <= 8; n++)
    await store.conversations.feedback(actor, project.id, run.id, {
      requestId: `f-${n}`,
      text: `Revision ${n}`,
    });
  await assert.rejects(
    store.conversations.feedback(actor, project.id, run.id, { requestId: "f-9", text: "Too many" }),
    { code: "FEEDBACK_LIMIT" },
  );
  await store.conversations.cancel(actor, project.id, run.id);
  await assert.rejects(
    store.conversations.feedback(actor, project.id, run.id, {
      requestId: "late",
      text: "Too late",
    }),
    { code: "RUN_NOT_ACTIVE" },
  );
  await queue.finish(run.id, {
    leaseToken: job.leaseToken,
    status: "cancelled",
    errorCode: "CANCELLED",
  });
  assert.deepEqual(await store.conversations.feedback(actor, project.id, run.id, input), {
    ...first,
    readAt: (await store.conversations.workspace(actor, project.id, run.id)).workspace.feedback?.[0]
      .readAt,
  });
  const next = await store.conversations.createRun(
    actor,
    project.id,
    conversation.id,
    "Continue",
    "second",
  );
  await db.query("UPDATE runs SET runtime_id='feedback-test' WHERE id=$1", [next.id]);
  const continued = await queue.claim();
  assert.ok(continued);
  const result = (await queue.task(next.id, {
    leaseToken: continued.leaseToken,
    operation: "feedback",
  })) as { feedback: { text: string }[] };
  assert.equal(result.feedback.length, 8);
  assert.equal(result.feedback[0].text, input.text);
  await queue.finish(next.id, {
    leaseToken: continued.leaseToken,
    status: "failed",
    errorCode: "MODEL_ERROR",
  });
  const { conversationStream } = await import(
    "../../apps/control-plane/src/modules/conversations/stream.ts"
  );
  const stream = conversationStream(
    store.conversations,
    actor,
    project.id,
    await store.conversations.run(actor, project.id, next.id),
  );
  const streamText = await stream.text();
  assert.match(streamText, /"type":"message-metadata"/);
  assert.match(streamText, /"runStatus":"failed"/);
  await store.conversations.remove(actor, project.id, conversation.id);
  assert.equal(
    (await db.query("SELECT id FROM task_feedback WHERE run_id=$1", [run.id])).length,
    0,
  );
});

test("large browser images survive the control-plane durable snapshot contract", {
  skip: process.env.TASK_SANDBOX_IMAGE
    ? false
    : "TASK_SANDBOX_IMAGE is not set; browser sandbox coverage is skipped",
  timeout: 60000,
}, async () => {
  const { startModelFixture } = await import("../fixtures/model-fixture.ts");
  const { executeJob } = await import("../../apps/runtime/src/agents/execute.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RuntimeTaskRequest } = await import("../../packages/contracts/src/index.ts");
  const root = await mkdtemp(join(tmpdir(), "platform-image-contract-"));
  const fixture = await startModelFixture(0, {
    toolSequence: [
      {
        name: "mastra_workspace_write_file",
        input: {
          path: "index.html",
          content:
            '<title>Image contract</title><canvas width="900" height="900"></canvas><script>const c=document.querySelector("canvas"),x=c.getContext("2d"),d=x.createImageData(900,900);for(let i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*256;d.data[i+1]=Math.random()*256;d.data[i+2]=Math.random()*256;d.data[i+3]=255;}x.putImageData(d,0,0);</script>',
          overwrite: true,
        },
      },
      {
        name: "mastra_workspace_execute_command",
        input: {
          command: "python3 -m http.server 5173 --bind 127.0.0.1 >/tmp/serve.log 2>&1 &",
          timeout: 5000,
        },
      },
      { name: "browser_goto", input: { url: "http://127.0.0.1:5173" } },
      { name: "browser_screenshot", input: { fullPage: true } },
    ],
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const project = await store.projects.create(actor, { name: "Image contract", description: "" });
    const model = await store.resources.createModel(actor, project.id, {
      name: "Image",
      baseUrl: `${fixture.url}/v1`,
      modelId: "fixture",
      apiKey: "fixture-key",
      capabilities: { vision: true, toolUse: true },
    });
    const agent = await store.agents.create(actor, project.id, {
      name: "Image",
      description: "",
      instructions: "Test",
      modelId: model.id,
      toolIds: [],
      maxSteps: 10,
      workspaceEnabled: true,
      executionLimits: { maxTokens: 2000000 },
    });
    await store.agents.publish(actor, project.id, agent.id, 1);
    const conversation = await store.conversations.create(actor, project.id, agent.id, "Image");
    const run = await store.conversations.createRun(
      actor,
      project.id,
      conversation.id,
      "Test",
      "image",
    );
    await db.query("INSERT INTO runtimes(id,name) VALUES($1,$2)", ["image-test", "Image test"]);
    await db.query("UPDATE runs SET runtime_id=$1 WHERE id=$2", ["image-test", run.id]);
    const queue = new Queue(db, store.vault, "image-test");
    const job = await queue.claim();
    assert.ok(job);
    assert.equal(job.runId, run.id);
    heartbeat = setInterval(() => {
      void queue.renew(run.id, job.leaseToken).catch(() => {});
    }, 3000);
    const task = async (input: Record<string, unknown>) => {
      try {
        if (input.operation === "save") {
          const { decodeSnapshot } = await import("../../apps/runtime/src/agents/durable.ts");
          assert.doesNotMatch(
            JSON.stringify(decodeSnapshot(input.snapshot)),
            /__snapshot_[a-f0-9-]{36}_\d+__/,
          );
        }
        return JSON.parse(
          JSON.stringify(
            await queue.task(
              run.id,
              RuntimeTaskRequest.parse({ ...input, leaseToken: job.leaseToken }),
            ),
          ),
        );
      } catch (error) {
        throw new Error(
          JSON.stringify({
            operation: input.operation,
            snapshotBytes: JSON.stringify(input.snapshot ?? {}).length,
            snapshotRunId: (input.snapshot as { runId?: string })?.runId,
            runId: run.id,
            code: (error as { code?: string }).code,
          }),
        );
      }
    };
    const result = await executeJob(job, AbortSignal.timeout(50000), async () => {}, {
      task,
      taskWorkspaceRoot: root,
      taskSandboxImage: process.env.TASK_SANDBOX_IMAGE,
      uploadArtifact: (input) => task({ ...input, operation: "artifact" }),
      authorizeMcp: async () => ({}),
      queryKnowledge: async () => ({}),
    });
    assert.ok(result.parts.length);
    assert.ok(fixture.imageInputs > 0);
  } finally {
    clearInterval(heartbeat);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider-confirmed context overflow queues a compaction run for the retry", async () => {
  const project = await store.projects.create(actor, { name: "Overflow", description: "" });
  const model = await store.resources.createModel(actor, project.id, {
    name: "Overflow model",
    baseUrl: "http://127.0.0.1:9999/v1",
    modelId: "test",
    apiKey: "",
  });
  const agent = await store.agents.create(actor, project.id, {
    name: "Overflow",
    description: "",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    maxSteps: 3,
  });
  await store.agents.publish(actor, project.id, agent.id, 1);
  const thread = await store.conversations.create(actor, project.id, agent.id, "Overflow");
  const run = await store.conversations.createRun(
    actor,
    project.id,
    thread.id,
    "这条提问超出了模型窗口",
    "overflow-1",
  );
  const { queue } = createApp(store, {
    origin: "http://127.0.0.1:5173",
    runtimeToken: "test-token",
  });
  // A previous test may have left a queued run behind; drain until ours.
  let job: Awaited<ReturnType<typeof queue.claim>> = null;
  for (let attempt = 0; attempt < 5 && !job; attempt++) {
    const claimed = await queue.claim();
    assert.ok(claimed);
    if (claimed.runId === run.id) job = claimed;
    else
      await queue.finish(claimed.runId, {
        leaseToken: claimed.leaseToken,
        status: "failed",
        errorCode: "CANCELLED",
      });
  }
  assert.ok(job);
  await queue.finish(job.runId, {
    leaseToken: job.leaseToken,
    status: "failed",
    errorCode: "CONTEXT_WINDOW_EXCEEDED",
  });
  const [failed] = await db.query("SELECT status,error_code FROM runs WHERE id=$1", [run.id]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "CONTEXT_WINDOW_EXCEEDED");
  const [compact] = await db.query(
    "SELECT id,input_text,context_action,context_through FROM runs WHERE conversation_id=$1 AND context_action='compact' ORDER BY created_at DESC LIMIT 1",
    [thread.id],
  );
  assert.ok(compact, "overflow must queue a compaction run");
  assert.equal(compact.input_text, "/compact");
  assert.ok(compact.context_through !== null);
  // The queued compaction claims with an empty tool set and the conversation's
  // model view; the user question from the failed run stays in the transcript.
  const compactJob = await queue.claim();
  assert.ok(compactJob);
  assert.equal(compactJob.runId, compact.id);
  assert.ok(compactJob.compaction);
  assert.ok(compactJob.compaction.transcript.includes("这条提问超出了模型窗口"));
  await queue.finish(compactJob.runId, {
    leaseToken: compactJob.leaseToken,
    status: "failed",
    errorCode: "CANCELLED",
  });
  assert.equal(await queue.claim(), null);
});
