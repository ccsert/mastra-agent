import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, RunEvent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationTrajectory } from "../../src/features/runs/ConversationTrajectory.tsx";
import {
  projectConversation,
  projectTrajectory,
  sessionLog,
  traceDuration,
} from "../../src/features/runs/trajectory.ts";

const baseRun: Run = {
  id: "run",
  conversationId: "conversation",
  releaseId: "release",
  releaseVersion: 1,
  agentName: "Agent",
  runtimeId: "runtime",
  createdAt: "2026-09-09T00:00:00Z",
  finishedAt: null,
  status: "succeeded",
  errorCode: null,
  inputText: "第一轮输入",
  agentInstructions: "发布提示词",
  registeredTools: [],
  selectedSkills: [],
  outputText: null,
};
function RunTrajectory({
  events,
  status,
  complete,
  run,
}: {
  events: RunEvent[];
  status: Run["status"];
  complete: boolean;
  run?: Partial<Run>;
}) {
  const current = { ...baseRun, ...run, status };
  const request = events.find((e) => e.chunk.type === "data-model-request") ?? null;
  return (
    <ConversationTrajectory
      totalTurns={1}
      records={projectConversation({ run: current, request }, [
        { number: 1, run: current, events, hasMoreEvents: !complete },
      ])}
    />
  );
}
afterEach(cleanup);
test("the conversation reader does not expose transport steps as reading groups", () => {
  render(<RunTrajectory events={events} status="succeeded" complete />);
  assert.equal(!!screen.queryByText("步骤 1"), false);
  assert.equal(!!screen.queryByText("全部原始事件", { exact: false }), false);
});
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
test("trajectory inspector shows structured input and failure without transport rows", () => {
  render(<RunTrajectory events={events} status="failed" complete />);
  fireEvent.click(screen.getByRole("button", { name: /^order_query/ }));
  const inspector = screen.getByRole("region", { name: "轨迹记录详情" });
  fireEvent.click(screen.getByRole("tab", { name: "参数" }));
  assert.match(inspector.textContent ?? "", /synthetic-42/);
  fireEvent.click(screen.getByRole("tab", { name: "结果" }));
  assert.match(inspector.textContent ?? "", /订单服务超时/);
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "knowledge" } });
  assert.equal(screen.queryByRole("button", { name: /^order_query/ }), null);
  assert.ok(screen.getByRole("button", { name: /^knowledge_search/ }));
  fireEvent.click(screen.getByRole("button", { name: "收起轮次" }));
  fireEvent.click(screen.getByRole("button", { name: "定位 order_query · 第 1 轮" }));
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
  fireEvent.click(screen.getByRole("button", { name: "模型" }));
  fireEvent.click(screen.getByRole("button", { name: /^模型请求/ }));
  fireEvent.click(screen.getByRole("tab", { name: "请求内容" }));
  assert.match(screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "", /qwen/);
  const historical = projectTrajectory([], "succeeded", true, run)[0].records[0];
  assert.equal(historical.text, "发布提示词");
  assert.match(historical.source ?? "", /历史运行未记录完整模型请求/);
});

test("multiple runs form ordered user turns with one system/tool catalogue and no transport fragments", () => {
  const request = event(0, {
    type: "data-model-request",
    data: {
      requestIndex: 1,
      request: {
        model: "qwen",
        messages: [{ role: "system", content: "完整提示词" }],
        tools: [
          {
            type: "function",
            function: {
              name: "order_query",
              description: "查询订单",
              parameters: { type: "object", properties: { orderId: { type: "string" } } },
            },
          },
        ],
      },
    },
  });
  const second = { ...baseRun, id: "second", inputText: "第二轮追问" };
  const records = projectConversation({ run: baseRun, request }, [
    { number: 2, run: second, events, hasMoreEvents: false },
    {
      number: 1,
      run: baseRun,
      events: [request, ...events.map((e) => ({ ...e, seq: e.seq + 1 }))],
      hasMoreEvents: false,
    },
  ]);
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  assert.deepEqual(
    records.filter((r) => r.kind === "user").map((r) => r.turn),
    [1, 2],
  );
  assert.equal(records.filter((r) => r.kind === "system").length, 1);
  assert.equal(records.filter((r) => r.kind === "context").length, 0);
  assert.match(
    JSON.stringify(sessionLog(records).find((r) => r.kind === "model")?.request),
    /qwen/,
  );
  assert.equal(records.find((r) => r.kind === "user")?.execution?.id, baseRun.id);
  assert.ok(!JSON.stringify(sessionLog(records)).includes("text-delta"));
  render(<ConversationTrajectory records={records} totalTurns={2} />);
  assert.ok(screen.getByText("第 1 轮"));
  assert.ok(screen.getByText("第 2 轮"));
  assert.equal(!!screen.queryByText(/步骤/), false);
  fireEvent.click(screen.getByRole("button", { name: /^初始系统提示词/ }));
  fireEvent.click(screen.getByRole("tab", { name: "工具 (1)" }));
  assert.ok(screen.getByText("查询订单"));
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /orderId/);
  assert.equal(!!screen.queryByRole("tab", { name: /事件/ }), false);
});
