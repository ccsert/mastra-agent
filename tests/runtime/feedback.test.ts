import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  coalesceReplayDeltas,
  replayRunMessage,
} from "../../apps/control-plane/src/modules/conversations/history.ts";
import { executeJob } from "../../apps/runtime/src/agents/execute.ts";
import { agentJob } from "../fixtures/agent-job.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";

test("a running agent receives feedback at its next model boundary", async () => {
  const fixture = await startModelFixture(0, {
    toolSequence: [
      {
        name: "update_plan",
        input: {
          baseRevision: 0,
          title: "Inspect page",
          explanation: "Begin verification",
          items: [{ id: "check", title: "Inspect", status: "in_progress" }],
        },
      },
    ],
  });
  const job = agentJob(`${fixture.url}/v1`);
  job.snapshot.agent.maxSteps = 3;
  job.snapshot.agent.planningEnabled = true;
  try {
    await executeJob(job, AbortSignal.timeout(15000), async () => {}, {
      readFeedback: async () =>
        fixture.calls
          ? [
              {
                id: randomUUID(),
                runId: job.runId,
                text: "Use cobalt-492 for the mobile header",
                createdAt: new Date().toISOString(),
                readAt: null,
              },
            ]
          : [],
      authorizeMcp: async () => ({}),
      queryKnowledge: async () => ({}),
    });
    assert.ok(fixture.systemPrompts.length >= 2);
    assert.doesNotMatch(fixture.systemPrompts[0], /cobalt-492/);
    assert.match(fixture.systemPrompts[1], /cobalt-492/);
    assert.ok(fixture.systemPrompts[1].includes('\\"currentRun\\":true'));
    assert.match(fixture.systemPrompts[1], /violet-317/);
  } finally {
    await fixture.close();
  }
});

test("history replay coalesces typing fragments without changing message content or raw events", async () => {
  const chunks = [
    { type: "start", messageId: "answer" },
    { type: "text-start", id: "text" },
    ...Array.from({ length: 10000 }, () => ({ type: "text-delta", id: "text", delta: "字" })),
    { type: "text-end", id: "text" },
  ];
  const compact = coalesceReplayDeltas(chunks);
  assert.equal(compact.length, 4);
  const message = await replayRunMessage(chunks);
  assert.deepEqual(message?.parts, [
    { type: "text", text: "字".repeat(10000), state: "done", providerMetadata: undefined },
  ]);
  assert.equal(chunks.length, 10003);
  assert.equal("delta" in chunks[2] && chunks[2].delta, "字");
});
