import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createAgentApplication } from "../../packages/agent-ui/src/index.ts";
import { AgentAppManifest, AgentAppRegistration } from "../../packages/contracts/src/index.ts";

const schema = {
  type: "object",
  properties: { value: { type: "string", maxLength: 20 } },
  required: ["value"],
  additionalProperties: false,
};
const manifest = AgentAppManifest.parse({
  protocolVersion: "1.0",
  appId: "test.orders",
  name: "Test",
  version: "1",
  actions: [
    {
      id: "draft.patch",
      title: "Patch",
      description: "Patch draft",
      effect: "draft",
      inputSchema: schema,
      outputSchema: schema,
    },
  ],
});
function fixture(run?: (signal: AbortSignal) => Promise<void>) {
  let value = "old",
    calls = 0;
  const app = createAgentApplication({
    manifest,
    observe: () => ({
      page: { id: "orders", title: "Orders" },
      ready: true,
      state: { value },
      summary: "Synthetic",
      actions: [{ id: "draft.patch", available: true }],
    }),
    handlers: {
      "draft.patch": async (args, { signal }) => {
        calls++;
        value = String(args.value);
        await run?.(signal);
        return { output: { value }, message: "Updated draft" };
      },
    },
  });
  return {
    app,
    calls: () => calls,
    edit: () => {
      value = "manual edit";
    },
    invoke: (args = { value: "new" }) => ({
      requestId: randomUUID(),
      action: "draft.patch",
      expectedRevision: app.observe().revision,
      args,
    }),
  };
}
test("application SDK enforces draft consent, validation, revision and idempotent acknowledgments", async () => {
  const f = fixture();
  assert.equal((await f.app.invoke(f.invoke())).code, "NOT_CONNECTED");
  f.app.enable();
  assert.equal((await f.app.invoke(f.invoke())).code, "DRAFT_NOT_GRANTED");
  f.app.enable(true);
  assert.equal((await f.app.invoke(f.invoke({ value: "x".repeat(21) }))).code, "INVALID_INPUT");
  const stale = f.invoke();
  f.edit();
  assert.equal((await f.app.invoke(stale)).code, "STALE_REVISION");
  assert.equal(f.calls(), 0);
  const input = f.invoke(),
    results = await Promise.all([f.app.invoke(input), f.app.invoke(input)]);
  assert.equal(f.calls(), 1);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, "succeeded");
  assert.equal(results[0].persistence, "not-requested");
  assert.notEqual(results[0].view.revision, input.expectedRevision);
  await assert.rejects(
    f.app.invoke({ ...input, args: { value: "different" } }),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("stop after the handler starts leaves an unknown result and never retries the handler", async () => {
  let release: () => void = () => {};
  const f = fixture(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.app.enable(true);
  const input = f.invoke(),
    pending = f.app.invoke(input);
  assert.equal(f.calls(), 1);
  assert.equal((await f.app.invoke(f.invoke())).code, "PAGE_BUSY");
  f.app.stop();
  release();
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.uiApplied, false);
  f.app.enable(true);
  assert.equal((await f.app.invoke(input)).status, "unknown");
  assert.equal(f.calls(), 1);
});
test("application schema and registration reject unsafe or unsupported declarations", () => {
  for (const url of ["javascript:alert(1)", "http://app.example", "https://user:pass@app.example"])
    assert.equal(AgentAppRegistration.safeParse({ url, manifest }).success, false);
  assert.equal(
    AgentAppRegistration.safeParse({ url: "http://127.0.0.1:5181/", manifest }).success,
    true,
  );
  assert.equal(
    AgentAppManifest.safeParse({ ...manifest, actions: [...manifest.actions, ...manifest.actions] })
      .success,
    false,
  );
  assert.equal(
    AgentAppManifest.safeParse({
      ...manifest,
      actions: [
        { ...manifest.actions[0], inputSchema: { $ref: "https://example.com/remote.json" } },
      ],
    }).success,
    false,
  );
  assert.equal(
    AgentAppManifest.safeParse({
      ...manifest,
      actions: [{ ...manifest.actions[0], effect: "write" }],
    }).success,
    false,
  );
});

test("user edits during the activity indicator paint invalidate the pending action", async () => {
  const f = fixture();
  f.app.enable(true);
  const original = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      f.edit();
      callback(0);
      return 1;
    },
  });
  try {
    const outcome = await f.app.invoke(f.invoke());
    assert.equal(outcome.code, "STALE_REVISION");
    assert.equal(f.calls(), 0);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});
