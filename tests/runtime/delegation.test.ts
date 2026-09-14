import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createDelegation } from "../../apps/runtime/src/agents/delegation.ts";
import { ExecutionJob, SubagentLifecycle } from "../../packages/contracts/src/index.ts";

type ChildExecutor = Parameters<typeof createDelegation>[3];
type UIMessage = Awaited<ReturnType<ChildExecutor>>;
type UIMessageChunk = Parameters<Parameters<typeof createDelegation>[2]>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function job(maxParallel = 1, maxCalls = 3) {
  const id = randomUUID();
  return ExecutionJob.parse({
    runId: randomUUID(),
    leaseToken: "lease",
    deadline: Date.now() + 60000,
    messages: [
      { id: randomUUID(), role: "user", parts: [{ type: "text", text: "PARENT_ONLY_CONTEXT" }] },
    ],
    skillVersionIds: [],
    credentials: { modelApiKey: "fixture-secret", toolTokens: {} },
    snapshot: {
      agent: {
        name: "parent",
        instructions: "rules",
        modelId: id,
        toolIds: [],
        delegation: { enabled: true, maxParallel, maxCalls, maxSteps: 2 },
      },
      model: {
        id,
        projectId: randomUUID(),
        name: "test",
        baseUrl: "http://127.0.0.1:1234/v1",
        modelId: "fixture",
        hasCredential: true,
        provider: "openai-compatible",
        createdAt: new Date().toISOString(),
      },
      tools: [],
      adapterVersion: "mastra-agent-v1",
    },
  });
}
const answer: UIMessage = {
  id: "answer",
  role: "assistant",
  parts: [{ type: "text", text: "child result" }],
};
const task = (n: number) => ({ name: `worker-${n}`, task: `task-${n}` });
function recorder() {
  const events: UIMessageChunk[] = [];
  return {
    events,
    emit: async (e: UIMessageChunk) => {
      events.push(e);
    },
    states: () =>
      events.flatMap((e) => (e.type === "data-subagent" ? [SubagentLifecycle.parse(e.data)] : [])),
  };
}

test("delegation enforces its call budget and concurrency while isolating context and keeping the release", async () => {
  const root = job(),
    log = recorder(),
    gates: Array<ReturnType<typeof deferred<UIMessage>>> = [];
  let active = 0,
    peak = 0;
  const delegate = createDelegation(root, new AbortController().signal, log.emit, async (child) => {
    active++;
    peak = Math.max(peak, active);
    assert.notEqual(child.runId, root.runId);
    assert.equal(child.snapshot.agent.delegation, undefined);
    assert.equal(child.snapshot.agent.maxSteps, 2);
    assert.equal(child.snapshot.model, root.snapshot.model);
    assert.equal(child.snapshot.tools, root.snapshot.tools);
    assert.equal(child.credentials, root.credentials);
    assert.equal(JSON.stringify(child.messages).includes("PARENT_ONLY_CONTEXT"), false);
    const gate = deferred<UIMessage>();
    gates.push(gate);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  });
  const running = [
    delegate.run(task(1), "call-1"),
    delegate.run(task(2), "call-2"),
    delegate.run(task(3), "call-3"),
  ];
  assert.equal((await delegate.run(task(4), "call-4")).status, "rejected");
  await setImmediate();
  assert.equal(gates.length, 1);
  for (let i = 0; i < 3; i++) {
    gates[i].resolve(answer);
    await setImmediate();
  }
  const results = await Promise.all(running);
  assert.ok(results.every((r) => r.status === "succeeded"));
  assert.equal(peak, 1);
  assert.equal(log.states().filter((s) => s.status === "queued").length, 3);
  assert.equal(log.states().filter((s) => s.status === "succeeded").length, 3);
  assert.equal(JSON.stringify(log.events).includes("fixture-secret"), false);
  await delegate.close();
});

test("parent cancellation stops running and queued children without dispatching queued work", async () => {
  const root = job(),
    controller = new AbortController(),
    log = recorder();
  let entered = 0;
  const delegate = createDelegation(root, controller.signal, log.emit, async (_job, signal) => {
    entered++;
    return new Promise<UIMessage>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  const first = delegate.run(task(1), "call-1"),
    second = delegate.run(task(2), "call-2");
  await setImmediate();
  controller.abort();
  assert.deepEqual(
    (await Promise.all([first, second])).map((r) => r.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(entered, 1);
  assert.equal(log.states().filter((s) => s.status === "cancelled").length, 2);
  await delegate.close();
});

test("a child failure is recorded and releases its slot for the next child", async () => {
  const root = job(),
    log = recorder();
  let entered = 0;
  const delegate = createDelegation(root, new AbortController().signal, log.emit, async () => {
    if (++entered === 1) throw new Error("provider internals");
    return answer;
  });
  const results = await Promise.all([
    delegate.run(task(1), "call-1"),
    delegate.run(task(2), "call-2"),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["failed", "succeeded"],
  );
  assert.equal(results[0].errorCode, "SUBAGENT_ERROR");
  assert.equal(JSON.stringify(log.events).includes("provider internals"), false);
  await delegate.close();
});
