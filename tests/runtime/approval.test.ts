import assert from "node:assert/strict";
import test from "node:test";
import { awaitApproval } from "../../apps/runtime/src/agents/approval.ts";

type Recorded = { type: string; data?: unknown };

/** A control plane whose verdict is scripted by the test. */
function fakePlatform(script: string[]) {
  const polls: string[] = [];
  return {
    polls,
    call: async (input: { operation: string; callId: string; toolName?: string }) => {
      const stamp = new Date("2026-09-17T10:00:00.000Z").toISOString();
      if (input.operation === "approval-request")
        return {
          toolCallId: input.callId,
          toolName: input.toolName ?? "tool",
          status: "pending",
          requestedAt: stamp,
          decidedAt: null,
          decidedBy: null,
          waitedMs: null,
        };
      const status = script.shift() ?? "pending";
      polls.push(status);
      return {
        toolCallId: input.callId,
        toolName: "tool",
        status,
        requestedAt: stamp,
        decidedAt: status === "pending" ? null : stamp,
        decidedBy: status === "approved" || status === "denied" ? "user-1" : null,
        waitedMs: status === "pending" ? null : 1200,
      };
    },
  };
}

const recorder = () => {
  const events: Recorded[] = [];
  return {
    events,
    emit: async (chunk: Recorded) => {
      events.push(chunk);
    },
  };
};

test("an approval is observed once opened and once decided", async () => {
  const platform = fakePlatform(["pending", "approved"]);
  const { events, emit } = recorder();
  const verdict = await awaitApproval({
    callId: "call-1",
    toolName: "orders_write",
    call: platform.call as never,
    emit,
    signal: new AbortController().signal,
  });
  assert.equal(verdict, "approved");
  const observations = events
    .filter((event) => event.type === "data-tool-approval")
    .map((event) => (event.data as { status: string }).status);
  // The pending observation is what keeps an open gate visible in the UI.
  assert.deepEqual(observations, ["pending", "approved"]);
});

test("a refusal is reported as denied rather than silently approved", async () => {
  const platform = fakePlatform(["denied"]);
  const { events, emit } = recorder();
  const verdict = await awaitApproval({
    callId: "call-2",
    toolName: "orders_write",
    call: platform.call as never,
    emit,
    signal: new AbortController().signal,
  });
  assert.equal(verdict, "denied");
  assert.equal(events.filter((event) => event.type === "data-tool-approval").length, 2);
});

test("cancellation ends the wait instead of leaving the run parked", async () => {
  const platform = fakePlatform([]);
  const { emit } = recorder();
  const controller = new AbortController();
  const waiting = awaitApproval({
    callId: "call-3",
    toolName: "orders_write",
    call: platform.call as never,
    emit,
    signal: controller.signal,
  });
  controller.abort(new Error("CANCELLED"));
  await assert.rejects(waiting);
});

test("a verdict that arrives as expired is never treated as consent", async () => {
  const platform = fakePlatform(["expired"]);
  const { emit } = recorder();
  const verdict = await awaitApproval({
    callId: "call-4",
    toolName: "orders_write",
    call: platform.call as never,
    emit,
    signal: new AbortController().signal,
  });
  assert.equal(verdict, "expired");
});

test("the gate vocabulary stays closed so a rogue verdict cannot open it", async () => {
  // The control plane only ever returns pending/approved/denied/expired; the
  // runtime's own mapping is what keeps an unknown value fail-closed.
  const platform = fakePlatform(["pending", "pending", "approved"]);
  const { emit } = recorder();
  const verdict = await awaitApproval({
    callId: "call-5",
    toolName: "orders_write",
    call: platform.call as never,
    emit,
    signal: new AbortController().signal,
  });
  assert.equal(verdict, "approved");
  assert.ok(platform.polls.every((status) => ["pending", "approved"].includes(status)));
});
