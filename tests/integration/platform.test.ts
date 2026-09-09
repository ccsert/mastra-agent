import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { hashPassword, sha256, Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Queue } from "../../apps/control-plane/src/modules/conversations/queue.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import type { Principal } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";

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
  await queue.append(run.id, job.leaseToken, 0, { type: "start", messageId: "assistant" });
  await queue.append(run.id, job.leaseToken, 0, { messageId: "assistant", type: "start" });
  await assert.rejects(
    () => queue.append(run.id, job.leaseToken, 0, { type: "start", messageId: "different" }),
    { code: "EVENT_CONFLICT" },
  );
  await assert.rejects(
    () => queue.append(run.id, job.leaseToken, 2, { type: "text-start", id: "text" }),
    { code: "EVENT_SEQUENCE" },
  );
  await assert.rejects(() => queue.append(run.id, job.leaseToken, 1, { type: "not-a-chunk" }), {
    code: "INVALID_EVENT",
  });
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
        await queue.append(job.runId, job.leaseToken, seq, chunk);
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
