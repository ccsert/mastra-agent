import assert from "node:assert/strict";
import test from "node:test";
import { runEventDto } from "../../apps/control-plane/src/modules/conversations/records.ts";
import { reportedTokenUsage } from "../../packages/contracts/src/trajectory.ts";

test("unknown usage is never a zero-token completion, while reported zero is preserved", () => {
  assert.equal(reportedTokenUsage({ totalTokens: 0 }).totalTokens, null);
  assert.equal(
    reportedTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }).totalTokens,
    0,
  );
  assert.equal(
    reportedTokenUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }).totalTokens,
    120,
  );
});

test("legacy zero totals are normalized in the typed read model without rewriting the original event", () => {
  const usage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: 0,
    reasoningTokens: null,
    cachedInputTokens: null,
  };
  const chunk = {
    type: "data-run-usage",
    data: {
      usage,
      steps: 1,
      finishReason: "stop",
      traceId: null,
      spanId: null,
      perStep: [{ stepIndex: 0, modelId: "old", finishReason: "stop", usage }],
    },
  };
  const result = runEventDto({ seq: 1, chunk, created_at: new Date(), occurred_at: null });
  assert.equal(result.observation?.type, "data-run-usage");
  if (result.observation?.type === "data-run-usage") {
    assert.equal(result.observation.data.usage.totalTokens, null);
    assert.equal(result.observation.data.perStep[0]?.usage.totalTokens, null);
  }
  assert.equal(chunk.data.usage.totalTokens, 0);
  assert.equal(result.timeSource, "control-plane");
});
