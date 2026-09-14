import assert from "node:assert/strict";
import { test } from "node:test";
import {
  retryEvaluationRequest,
  scoreEvidence,
  summarizeEvidence,
} from "../../scripts/knowledge-evaluation.ts";

test("knowledge evidence scoring requires all necessary sources and separates unknown questions", () => {
  const item = {
    id: "cross",
    category: "cross",
    query: "rules",
    expected: [
      { filename: "roles.md", contains: "编辑者不能发布" },
      { filename: "approval.md", contains: "管理员复核" },
    ],
  };
  const hit = {
    filename: "roles.md",
    content: "编辑者不能发布",
    contentHash: "hash",
    similarity: 0.9,
    rerankScore: null,
  };
  const half = scoreEvidence(item, [hit]);
  assert.equal(half.evidenceRecall, 0.5);
  assert.equal(half.completeEvidence, false);
  const complete = scoreEvidence(item, [
    hit,
    { ...hit, filename: "approval.md", content: "需要管理员复核" },
  ]);
  assert.equal(complete.completeEvidence, true);
  const absent = scoreEvidence({ ...item, id: "unknown", expected: [] }, [hit]);
  assert.equal(absent.completeEvidence, null);
  assert.equal(absent.unsupportedCandidates, 1);
  const summary = summarizeEvidence([half, complete, absent]);
  assert.equal(summary.completeEvidenceRate, 0.5);
  assert.equal(summary.meanEvidenceRecall, 0.75);
  assert.equal(summary.unanswerableCandidateRate, 1);
});
test("evaluation retries only transient model transport failures and exposes attempt count", async () => {
  let calls = 0;
  assert.deepEqual(
    await retryEvaluationRequest(async () => {
      if (++calls < 2) throw new TypeError("fetch failed");
      return "ok";
    }),
    { value: "ok", attempts: 2 },
  );
  calls = 0;
  await assert.rejects(
    retryEvaluationRequest(async () => {
      calls++;
      throw new Error("INVALID_MODEL_RESPONSE");
    }),
    /INVALID_MODEL_RESPONSE/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryEvaluationRequest(async () => {
      calls++;
      throw new TypeError("fetch failed");
    }),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});
