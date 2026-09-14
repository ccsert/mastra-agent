import assert from "node:assert/strict";
import test from "node:test";
import { toolExecutionHooks } from "../../apps/runtime/src/agents/execute.ts";
import {
  ToolExecution,
  type TraceToolSource,
  traceEventNames,
} from "../../packages/contracts/src/index.ts";

type Recorded = { type: string; transient?: boolean; data?: Record<string, unknown> };

/** Rejects when told to, so a delivery failure can be shown not to alter a call. */
function recorder(reject = false) {
  const events: Recorded[] = [];
  return {
    events,
    onChunk: async (chunk: Recorded) => {
      if (reject) throw new Error("delivery unavailable");
      events.push(chunk);
    },
    all: (type: string) => events.filter((event) => event.type === type),
  };
}

const sources = (...entries: [string, TraceToolSource][]) => new Map(entries);

/**
 * Mirrors how Mastra's own `wrapToolWithHooks` calls these hooks: the same
 * `context` object on both sides, `error` attached only when the call threw.
 */
function hooksFor(
  sourceMap: Map<string, TraceToolSource>,
  onChunk: (chunk: Recorded) => Promise<void>,
) {
  const hooks = toolExecutionHooks(sourceMap, onChunk as never);
  const call = {
    toolName: "sum_values",
    input: { values: [40, 80] },
    context: { agent: { toolCallId: "call-1" } } as unknown,
  };
  return {
    hook: hooks,
    async start(overrides: Partial<typeof call> = {}) {
      await hooks.beforeToolCall?.({ ...call, ...overrides });
    },
    async finish(
      result: { output?: unknown; error?: unknown },
      overrides: Partial<typeof call> = {},
    ) {
      await hooks.afterToolCall?.({ ...call, ...overrides, ...result });
    },
  };
}

test("a completed tool call is recorded with its own name, source and duration", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  await caseHooks.finish({ output: { total: 120 } });

  const [event] = all(traceEventNames.toolExecution);
  assert.equal(event?.transient, true);
  const execution = ToolExecution.parse(event?.data);
  assert.equal(execution.toolCallId, "call-1");
  assert.equal(execution.toolName, "sum_values");
  assert.equal(execution.source, "sum");
  assert.equal(execution.outcome, "succeeded");
  assert.equal(execution.errorCode, undefined);
  assert.ok(execution.durationMs >= 0);
  // Timestamps come from the runtime's clock, so they must round-trip as instants.
  assert.ok(!Number.isNaN(Date.parse(execution.startedAt)));
  assert.ok(Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt));
});

test("a tool that returns undefined is still a succeeded call, not a failed one", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  // Mastra spreads the tool's own output, which may legitimately be `undefined`.
  await caseHooks.finish({ output: undefined });
  assert.equal(
    ToolExecution.parse(all(traceEventNames.toolExecution)[0]?.data).outcome,
    "succeeded",
  );
});

test("a failed tool call is recorded as failed and keeps a recognised platform code", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  await caseHooks.finish({ output: undefined, error: new Error("MCP_TIMEOUT") });

  const execution = ToolExecution.parse(all(traceEventNames.toolExecution)[0]?.data);
  assert.equal(execution.outcome, "failed");
  assert.equal(execution.errorCode, "MCP_TIMEOUT");
});

test("an unrecognised failure is recorded as failed without inventing an error code", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  await caseHooks.finish({ output: undefined, error: new Error("socket hang up") });

  const execution = ToolExecution.parse(all(traceEventNames.toolExecution)[0]?.data);
  assert.equal(execution.outcome, "failed");
  // The provider message is never copied into the code field.
  assert.equal(execution.errorCode, undefined);
});

test("a non-Error throw is still reported as a failed call", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  await caseHooks.finish({ output: undefined, error: "plain string rejection" });

  const execution = ToolExecution.parse(all(traceEventNames.toolExecution)[0]?.data);
  assert.equal(execution.outcome, "failed");
  assert.equal(execution.errorCode, undefined);
});

test("tools the runtime did not build are never timed or attributed to a guessed source", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  // Mastra mounts skill and workspace tools on the same hook path.
  await caseHooks.start({ toolName: "skill_read" });
  await caseHooks.finish({ output: "body" }, { toolName: "skill_read" });
  assert.equal(all(traceEventNames.toolExecution).length, 0);
});

test("a call with no model call id is left unrecorded rather than joined by guesswork", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start({ context: {} });
  await caseHooks.finish({ output: { total: 120 } }, { context: {} });
  assert.equal(all(traceEventNames.toolExecution).length, 0);
});

test("a finish without its matching start is not recorded as an instantaneous call", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.finish({ output: { total: 120 } });
  assert.equal(all(traceEventNames.toolExecution).length, 0);
});

test("an observation that cannot be delivered never rejects the hook", async () => {
  const { onChunk } = recorder(true);
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  await caseHooks.start();
  // Mastra does not guard these hooks, so a rejection here would replace the tool's
  // own result (and mask its real error on the failure path).
  await assert.doesNotReject(() => caseHooks.finish({ output: { total: 120 } }));
  await assert.doesNotReject(() => caseHooks.finish({ error: new Error("MCP_TIMEOUT") }));
});

test("each call is timed on its own, so a repeated tool call is not reported once", async () => {
  const { onChunk, all } = recorder();
  const caseHooks = hooksFor(sources(["sum_values", "sum"]), onChunk);
  for (const id of ["call-1", "call-2"]) {
    await caseHooks.start({ context: { agent: { toolCallId: id } } });
    await caseHooks.finish({ output: id }, { context: { agent: { toolCallId: id } } });
  }
  assert.deepEqual(
    all(traceEventNames.toolExecution).map((event) => event.data?.toolCallId),
    ["call-1", "call-2"],
  );
});
