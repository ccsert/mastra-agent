import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { RunEvent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RunTrajectory } from "../../src/features/runs/RunTrajectory.tsx";
import { projectTrajectory, traceDuration } from "../../src/features/runs/trajectory.ts";

afterEach(cleanup);
const event = (seq: number, chunk: RunEvent["chunk"]): RunEvent => ({
  seq,
  chunk,
  createdAt: new Date(1000 + seq * 100).toISOString(),
});
const events = [
  event(0, { type: "start-step" }),
  event(1, { type: "tool-input-start", toolCallId: "orders", toolName: "order_query" }),
  event(2, { type: "tool-input-start", toolCallId: "knowledge", toolName: "knowledge_search" }),
  event(3, {
    type: "tool-input-available",
    toolCallId: "orders",
    toolName: "order_query",
    input: { orderId: "synthetic-42" },
  }),
  event(4, { type: "tool-output-available", toolCallId: "knowledge", output: { sources: [] } }),
  event(5, { type: "tool-output-error", toolCallId: "orders", errorText: "订单服务超时" }),
  event(6, { type: "finish-step" }),
  event(7, { type: "start-step" }),
  event(8, { type: "text-start", id: "answer" }),
  event(9, { type: "text-delta", id: "answer", delta: "等待订单" }),
];
test("trajectory pairs interleaved calls by ID and preserves partial records across pages and cancellation", () => {
  const pending = projectTrajectory(events, "running", false);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].records[0].status, "failed");
  assert.equal(pending[0].records[1].status, "succeeded");
  assert.equal(traceDuration(pending[0].records[0]), "400 ms");
  assert.equal(traceDuration(pending[1].records[0]), "—");
  assert.equal(projectTrajectory(events, "cancelled", false)[1].records[0].status, "running");
  const complete = projectTrajectory([...events, events[5]], "cancelled", true);
  assert.equal(complete[1].records[0].status, "interrupted");
  assert.equal(complete[0].records[0].events.length, 3);
});
test("trajectory inspector shows structured input and failure with raw events available", () => {
  render(<RunTrajectory events={events} status="failed" complete />);
  fireEvent.click(screen.getByRole("button", { name: /^order_query/ }));
  const inspector = screen.getByRole("region", { name: "轨迹记录详情" });
  assert.match(inspector.textContent ?? "", /synthetic-42/);
  assert.match(inspector.textContent ?? "", /订单服务超时/);
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "knowledge" } });
  assert.equal(screen.queryByRole("button", { name: /^order_query/ }), null);
  assert.ok(screen.getByRole("button", { name: /^knowledge_search/ }));
  fireEvent.click(screen.getByRole("button", { name: "收起步骤" }));
  fireEvent.click(screen.getByRole("button", { name: "定位 order_query" }));
  assert.equal((screen.getByLabelText("搜索轨迹") as HTMLInputElement).value, "");
  assert.equal(
    screen.getByRole("button", { name: /^order_query/ }).getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "计时" }));
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /控制面接收事件的时间戳/);
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /400 ms/);
});

test("reused provider text IDs stay in their own step, including whitespace-only responses", () => {
  const reused = [
    event(0, { type: "start-step" }),
    event(1, { type: "text-start", id: "txt-0" }),
    event(2, { type: "text-delta", id: "txt-0", delta: "\n\n" }),
    event(3, { type: "text-end", id: "txt-0" }),
    event(4, { type: "finish-step" }),
    event(5, { type: "start-step" }),
    event(6, { type: "text-start", id: "txt-0" }),
    event(7, { type: "text-delta", id: "txt-0", delta: "订单总额 120" }),
    event(8, { type: "text-end", id: "txt-0" }),
  ];
  const steps = projectTrajectory(reused, "succeeded", true);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].records[0].text, "\n\n");
  assert.equal(steps[1].records[0].text, "订单总额 120");
  assert.notEqual(steps[0].records[0].id, steps[1].records[0].id);
  render(<RunTrajectory events={reused} status="succeeded" complete />);
  assert.ok(screen.getByText("模型未返回正文"));
});

test("trajectory exposes input categories, exact system prompts, and captured request provenance", () => {
  const request = event(0, {
    type: "data-model-request",
    transient: true,
    data: {
      requestIndex: 1,
      preparedAt: "2026-09-09T00:00:00Z",
      request: {
        model: "qwen",
        messages: [
          { role: "system", content: "实际系统提示词与 Skill 指令" },
          { role: "user", content: "合成订单输入" },
        ],
        tools: [],
      },
    },
  });
  const run = {
    id: "run",
    createdAt: request.createdAt,
    inputText: "合成订单输入",
    agentInstructions: "发布提示词",
  };
  render(
    <RunTrajectory
      events={[request, ...events.map((e) => ({ ...e, seq: e.seq + 1 }))]}
      status="succeeded"
      complete
      run={run}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^初始系统提示词/ }));
  assert.match(
    screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "",
    /实际系统提示词与 Skill 指令/,
  );
  assert.match(
    screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "",
    /Runtime 实际模型请求/,
  );
  fireEvent.click(screen.getByRole("button", { name: "输入" }));
  assert.ok(screen.getByRole("button", { name: /^用户输入/ }));
  assert.equal(screen.queryByRole("button", { name: /^order_query/ }), null);
  fireEvent.click(screen.getByRole("button", { name: /^运行上下文/ }));
  assert.match(screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "", /qwen/);
  const historical = projectTrajectory([], "succeeded", true, run)[0].records[0];
  assert.equal(historical.text, "发布提示词");
  assert.match(historical.source ?? "", /历史运行未记录完整模型请求/);
});
