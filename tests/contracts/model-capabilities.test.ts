import assert from "node:assert/strict";
import { test } from "node:test";
import { Model, ModelInput, ModelUpdate } from "../../packages/contracts/src/index.ts";

/**
 * Rows are stored as the input payload and re-parsed on every read, so a row
 * written before `vendor` and `capabilities` existed must still parse. `Model` is
 * built from `ModelInput.omit({ apiKey: true })`, so this also covers the stored
 * shape indirectly, but the read path is asserted directly here.
 */
test("a model row stored before vendor and capabilities existed still parses", () => {
  const legacy = {
    name: "内网 Qwen",
    baseUrl: "http://model.test/v1",
    kind: "chat" as const,
    modelId: "qwen3-27b",
    id: "2c57cb45-032a-45f2-9487-dcffdf085c7d",
    projectId: "9e2e826c-99ec-48a7-b9cd-2c3430054323",
    hasCredential: true,
    createdAt: "2026-09-09",
    provider: "openai-compatible" as const,
  };
  const parsed = Model.parse(legacy);
  assert.equal(parsed.vendor, "custom");
  // The inner defaults must be filled, not replaced by a bare empty object.
  assert.deepEqual(parsed.capabilities, { vision: false, toolUse: true });
});

test("an omitted capabilities object is filled from the field defaults", () => {
  const parsed = Model.parse({
    name: "内网 Qwen",
    baseUrl: "http://model.test/v1",
    modelId: "qwen3-27b",
    id: "2c57cb45-032a-45f2-9487-dcffdf085c7d",
    projectId: "9e2e826c-99ec-48a7-b9cd-2c3430054323",
    hasCredential: false,
    createdAt: "2026-09-09",
    provider: "openai-compatible",
  });
  assert.equal(parsed.kind, "chat");
  assert.deepEqual(parsed.capabilities, { vision: false, toolUse: true });
});

test("a partially declared capabilities object keeps its stated value", () => {
  const declared = ModelInput.parse({
    name: "视觉模型",
    baseUrl: "http://model.test/v1",
    modelId: "qwen-vl",
    capabilities: { vision: true },
  });
  assert.deepEqual(declared.capabilities, { vision: true, toolUse: true });
});

test("capabilities reject unknown keys instead of silently dropping them", () => {
  assert.equal(
    ModelInput.safeParse({
      name: "x",
      baseUrl: "http://model.test/v1",
      modelId: "m",
      capabilities: { vision: true, audio: true },
    }).success,
    false,
  );
});

test("an unknown vendor is rejected rather than stored", () => {
  assert.equal(
    ModelInput.safeParse({
      name: "x",
      baseUrl: "http://model.test/v1",
      modelId: "m",
      vendor: "not-a-vendor",
    }).success,
    false,
  );
});

test("updating without a key keeps the credential field optional", () => {
  const parsed = ModelUpdate.parse({
    name: "内网 Qwen",
    baseUrl: "http://model.test/v1",
    modelId: "qwen3-27b",
  });
  assert.equal(parsed.apiKey, undefined);
  assert.equal(parsed.vendor, "custom");
  assert.deepEqual(parsed.capabilities, { vision: false, toolUse: true });
});
