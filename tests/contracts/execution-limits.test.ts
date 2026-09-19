import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionLimits } from "../../packages/contracts/src/index.ts";

test("execution limits keep their defaults and accept every shipped preset", () => {
  const defaults = ExecutionLimits.parse({});
  assert.equal(defaults.maxTokens, 400000);
  assert.equal(defaults.contextTokens, 32000);
  for (const limits of [
    { maxModelCalls: 20, maxTokens: 100000 },
    { maxModelCalls: 60, maxTokens: 1000000 },
    { maxModelCalls: 160, maxTokens: 2000000 },
  ]) {
    assert.ok(ExecutionLimits.safeParse(limits).success, JSON.stringify(limits));
  }
});

test("context windows may reach modern model sizes", () => {
  assert.ok(
    ExecutionLimits.safeParse({
      maxTokens: 10000000,
      contextTokens: 1000000,
      maxOutputTokens: 8192,
    }).success,
  );
  assert.ok(
    ExecutionLimits.safeParse({
      maxTokens: 20000000,
      contextTokens: 2000000,
      maxOutputTokens: 32000,
    }).success,
  );
});

test("a run budget can stay below one full call (guard trips on the first request)", () => {
  // The form steers users away from this, but the runtime guard relies on
  // sub-window budgets to fail fast: keep them representable.
  const result = ExecutionLimits.safeParse({
    maxTokens: 1500,
    contextTokens: 4000,
    maxOutputTokens: 512,
  });
  assert.ok(result.success);
});
