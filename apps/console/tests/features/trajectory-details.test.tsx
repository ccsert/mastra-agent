import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, RunEvent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConversationTrajectory } from "../../src/features/runs/ConversationTrajectory.tsx";
import {
  foldTrace,
  projectConversation,
  type TraceRecord,
} from "../../src/features/runs/trajectory.ts";
import { contentTiming, contextChange } from "../../src/features/runs/trajectory-details.ts";

afterEach(cleanup);
const run: Run = {
  id: "run",
  conversationId: "conversation",
  releaseId: "release",
  releaseVersion: 1,
  agentName: "Agent",
  runtimeId: "runtime",
  status: "succeeded",
  createdAt: new Date(1000).toISOString(),
  finishedAt: new Date(3000).toISOString(),
  errorCode: null,
  inputText: "计算订单",
  agentInstructions: "规则",
  registeredTools: [],
  selectedSkills: [],
  outputText: "结果是 3",
};
const event = (
  seq: number,
  chunk: RunEvent["chunk"],
  observation?: RunEvent["observation"],
): RunEvent => ({
  seq,
  chunk,
  observation,
  createdAt: new Date(1000 + seq * 100).toISOString(),
  occurredAt: new Date(1000 + seq * 100).toISOString(),
  timeSource: "runtime",
});
const usage = {
  inputTokens: 120,
  outputTokens: 8,
  totalTokens: 128,
  reasoningTokens: 2,
  cachedInputTokens: 40,
};
const captured = [
  event(0, {
    type: "data-model-request",
    data: {
      requestIndex: 1,
      stepIndex: 0,
      request: { model: "fixture", messages: [{ role: "user", content: "计算订单" }], tools: [] },
    },
  }),
  event(1, { type: "start-step" }),
  event(2, { type: "reasoning-start", id: "r" }),
  event(3, { type: "reasoning-delta", id: "r", delta: "先检查订单" }),
  event(4, { type: "reasoning-end", id: "r" }),
  event(5, { type: "tool-input-start", toolName: "sum", toolCallId: "call" }),
  event(6, { type: "tool-input-delta", toolCallId: "call", inputTextDelta: '{"a":1}' }),
  event(7, { type: "tool-input-available", toolName: "sum", toolCallId: "call", input: { a: 1 } }),
  event(
    8,
    { type: "data-tool-start" },
    {
      type: "data-tool-start",
      data: {
        toolCallId: "call",
        toolName: "sum",
        source: "sum",
        startedAt: new Date(1800).toISOString(),
      },
    },
  ),
  event(9, { type: "tool-output-error", toolCallId: "call", errorText: "测试失败" }),
  event(10, { type: "text-start", id: "t" }),
  event(11, { type: "text-delta", id: "t", delta: "工具失败" }),
  event(12, { type: "text-end", id: "t" }),
  event(
    13,
    { type: "data-model-step" },
    {
      type: "data-model-step",
      data: {
        stepIndex: 0,
        completedAt: new Date(2300).toISOString(),
        modelId: "fixture",
        finishReason: "tool-calls",
        usage,
      },
    },
  ),
];
const project = () =>
  projectConversation({ run, request: captured[0] }, [
    { number: 1, run, events: captured, hasMoreEvents: false },
  ]);

test("requests keep independent ordered content blocks and their exact owning call", () => {
  const records = project(),
    request = records.find((r) => r.requestIndex === 1);
  assert.ok(request);
  const children = records.filter((r) => r.parentId === request.id);
  assert.deepEqual(
    children.map((r) => r.segment ?? r.kind),
    ["reasoning", "tool", "text"],
  );
  assert.deepEqual(
    request.childIds,
    children.map((r) => r.id),
  );
  assert.deepEqual(request.toolCalls, [children[1].id]);
  assert.equal(request.generation?.usage.totalTokens, 128);
  assert.equal(request.generation?.finishReason, "tool-calls");
  assert.equal(children[1].startedAt, new Date(1800).toISOString());
  assert.equal(children[1].status, "failed");
  const folded = foldTrace(records, { turns: new Set(), calls: new Set([request.id]) });
  assert.equal(
    folded.some((r) => r.parentId === request.id),
    false,
  );
  assert.equal(folded.find((r) => r.summary?.kind === "call")?.status, "failed");
});

test("content timing excludes empty frames and refuses control-plane receipt timestamps", () => {
  const records = project(),
    record = records.find((r) => r.requestIndex === 1);
  assert.ok(record);
  const children = records.filter((r) => r.parentId === record.id);
  record.modelTiming = {
    requestIndex: 1,
    httpStatus: 200,
    startedAt: run.createdAt,
    responseAt: null,
    firstByteAt: null,
    completedAt: new Date(3000).toISOString(),
    durationMs: 2000,
    firstByteMs: null,
    responseBytes: 100,
    outcome: "completed",
  };
  assert.equal(contentTiming(record, children).wait, 300);
  assert.equal(contentTiming(record, children).generating, 800);
  const historical = (r: TraceRecord) => ({
    ...r,
    events: r.events.map((e) => ({ ...e, timeSource: "control-plane" as const })),
  });
  assert.equal(contentTiming(historical(record), children.map(historical)).wait, null);
  assert.equal(contentTiming(historical(record), children.map(historical)).rate, null);
});

test("context comparison measures a common prefix and detects replacements and tool schema changes", () => {
  const record = project().find((r) => r.requestIndex === 1);
  assert.ok(record);
  const previous = {
    ...record,
    request: {
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "old" },
      ],
    },
    tools: [{ name: "sum", description: "old" }],
  };
  const next = {
    ...record,
    request: {
      messages: [
        { content: "rules", role: "system" },
        { role: "user", content: "new" },
        { role: "tool", content: "result" },
      ],
    },
    tools: [{ name: "sum", description: "new" }],
  };
  assert.deepEqual(contextChange(next, previous), {
    total: 3,
    shared: 1,
    added: 2,
    removed: 1,
    comparable: true,
    toolsAdded: [],
    toolsRemoved: [],
    definitionsChanged: true,
  });
  assert.equal(contextChange(next).comparable, false);
});

test("request overview navigates to children and search keeps their request and turn context", () => {
  const records = project();
  render(<ConversationTrajectory records={records} totalTurns={1} />);
  fireEvent.click(screen.getByRole("button", { name: "模型请求 #1 · 第 1 轮 · 完成" }));
  const inspector = screen.getByRole("region", { name: "轨迹记录详情" });
  assert.match(inspector.textContent ?? "", /120/);
  fireEvent.click(within(inspector).getByRole("button", { name: /^sum/ }));
  assert.match(
    screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "",
    /调用生命周期/,
  );
  assert.match(screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "", /测试失败/);
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "测试失败" } });
  assert.ok(screen.getByRole("button", { name: "模型请求 #1 · 第 1 轮 · 完成" }));
  assert.ok(screen.getByRole("button", { name: "用户输入 · 第 1 轮 · 完成" }));
  assert.ok(screen.getByRole("button", { name: "sum · 第 1 轮 · 失败" }));
});
