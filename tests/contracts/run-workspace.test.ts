import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { projectRunWorkspace } from "../../apps/control-plane/src/modules/conversations/workspace.ts";

test("workspace keeps child scopes separate and publishes only successful actual tool output", () => {
  const root = randomUUID(),
    childId = randomUUID(),
    at = new Date().toISOString();
  const state = {
    id: childId,
    parentRunId: root,
    parentToolCallId: "delegate",
    name: "核对",
    task: "复核总额",
    status: "running",
    queuedAt: at,
    startedAt: at,
    finishedAt: null,
    maxSteps: 3,
    depth: 1,
    modelId: "model",
    allowedTools: ["sum"],
  };
  const chunks = [
    { type: "text-delta", delta: "我生成了 /tmp/claim.csv" },
    { type: "data-subagent", data: state },
    { type: "tool-input-available", toolName: "sum", toolCallId: "same", input: {} },
    ...[
      { type: "tool-input-start", toolName: "sum", toolCallId: "same" },
      { type: "tool-input-available", toolName: "sum", toolCallId: "same", input: {} },
      { type: "tool-output-available", toolCallId: "same", output: { total: 10 } },
      { type: "text-delta", id: "text", delta: "核对结果 10" },
    ].map((chunk) => ({
      type: "data-subagent-event",
      data: { id: childId, parentToolCallId: "delegate", occurredAt: at, chunk },
    })),
    { type: "tool-output-error", toolCallId: "same", errorText: "FAILED" },
    { type: "data-subagent", data: { ...state, status: "succeeded", finishedAt: at } },
  ];
  const { workspace, files } = projectRunWorkspace(
    chunks.map((chunk, seq) => ({ seq, chunk, createdAt: at })),
  );
  assert.equal(files.length, 1);
  assert.equal(workspace.artifacts[0].subagentId, childId);
  assert.equal(new TextDecoder().decode(files[0].bytes), '{\n  "total": 10\n}');
  assert.equal(workspace.subagents[0].toolCount, 1);
  assert.equal(workspace.subagents[0].completedTools, 1);
  assert.equal(workspace.subagents[0].outputText, "核对结果 10");
  assert.equal(workspace.subagents[0].status, "succeeded");
});

test("interrupted history keeps recorded text and marks unfinished tools without inventing output", async () => {
  const { interruptedMessage } = await import(
    "../../apps/control-plane/src/modules/conversations/history.ts"
  );
  const id = randomUUID();
  const message = await interruptedMessage(id, "failed", "RUNTIME_LOST", [
    { type: "start", messageId: "upstream" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "已经确认第一部分。" },
    { type: "tool-input-available", toolCallId: "pending", toolName: "lookup", input: { id: 7 } },
    { type: "data-model-request", transient: true, data: { privateContext: "not a message" } },
  ]);
  assert.equal(message.id, `assistant-${id}`);
  assert.equal(message.metadata?.runStatus, "failed");
  assert.equal(message.metadata?.errorCode, "RUNTIME_LOST");
  assert.equal(message.parts[0].text, "已经确认第一部分。");
  assert.equal(message.parts[0].state, "done");
  assert.equal(message.parts[1].state, "output-error");
  assert.equal(message.parts[1].output, undefined);
  assert.equal(message.parts.length, 2);
});

test("platform capability discovery and proposals remain trace data instead of downloadable artifacts", () => {
  const events = [
    "platform_catalog",
    "platform_read",
    "platform_skill",
    "platform_propose",
    "platform_navigate",
  ].flatMap((toolName, index) => [
    { type: "tool-input-available", toolName, toolCallId: String(index), input: {} },
    {
      type: "tool-output-available",
      toolCallId: String(index),
      output: { items: [{ name: "Example" }], proposal: { title: "Prepared" } },
    },
  ]);
  const { workspace, files } = projectRunWorkspace(
    events.map((chunk, seq) => ({ seq, chunk, createdAt: new Date().toISOString() })),
  );
  assert.equal(workspace.artifacts.length, 0);
  assert.equal(files.length, 0);
});
