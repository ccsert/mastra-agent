import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, RunEvent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationTrajectory } from "../../src/features/runs/ConversationTrajectory.tsx";
import {
  createConversationProjector,
  foldTrace,
  projectConversation,
  projectTimeline,
  projectTrajectory,
  sessionLog,
  type TraceRecord,
  toolOwners,
  traceDuration,
  unfoldTarget,
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
const event = (seq: number, chunk: RunEvent["chunk"]): RunEvent => {
  const createdAt = new Date(1000 + seq * 100).toISOString();
  return { seq, chunk, createdAt, occurredAt: createdAt, timeSource: "runtime" };
};
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
test("long trajectories window their rows while reserving full scroll height", () => {
  const records: TraceRecord[] = Array.from({ length: 240 }, (_, index) => ({
    id: `record-${index}`,
    step: index,
    kind: index % 2 === 0 ? "tool" : "model",
    title: `记录 ${index}`,
    status: "succeeded",
    startedAt: new Date(1_000 + index * 10).toISOString(),
    finishedAt: new Date(1_000 + index * 10 + 5).toISOString(),
    text: `内容 ${index}`,
    events: [],
  }));
  render(<ConversationTrajectory records={records} totalTurns={1} />);
  const mounted = screen.getAllByRole("button", { name: /^记录 \d+/ });
  assert.ok(mounted.length > 0);
  assert.ok(mounted.length < records.length);
  const canvas = document.querySelector<HTMLElement>(".trace-virtual-canvas");
  assert.ok(canvas);
  assert.equal(canvas.style.height, `${records.length * 56}px`);
});
test("folding collapses a turn or a tool group into one summary row", () => {
  const at = (seq: number) => new Date(1_000 + seq * 100).toISOString();
  const record = (
    id: string,
    kind: TraceRecord["kind"],
    overrides: Partial<TraceRecord> = {},
  ): TraceRecord => ({
    id,
    step: 1,
    kind,
    title: id,
    status: "succeeded",
    startedAt: at(0),
    text: "",
    events: [],
    turn: 1,
    ...overrides,
  });
  const records: TraceRecord[] = [
    record("user", "user", { step: 0 }),
    record("model", "model", { finishedAt: at(2) }),
    record("tool-a", "tool", { finishedAt: at(2) }),
    record("tool-b", "tool", { finishedAt: at(2) }),
  ];
  const turnFolded = foldTrace(records, { turns: new Set([1]), calls: new Set() });
  assert.deepEqual(
    turnFolded.map((item) => item.id),
    ["user", "turn-summary:1"],
  );
  assert.equal(turnFolded[1].summary?.label, "3 条记录 · 2 次调用");
  const callFolded = foldTrace(records, { turns: new Set(), calls: new Set(["model"]) });
  assert.deepEqual(
    callFolded.map((item) => item.id),
    ["user", "model", "call-summary:model"],
  );
  assert.equal(callFolded[2].summary?.label, "2 次工具调用");
  assert.deepEqual(
    [...toolOwners(records)],
    [
      ["tool-a", "model"],
      ["tool-b", "model"],
    ],
  );
  assert.deepEqual(unfoldTarget(records, "tool-a"), { turn: 1, call: "model" });
});
test("the fold control hides tool rows behind a summary that expands", () => {
  render(<RunTrajectory events={events} status="succeeded" complete />);
  fireEvent.click(screen.getByRole("button", { name: "收起轮次" }));
  const summary = screen.getByRole("button", { name: /展开第 1 轮 ·/ });
  assert.equal(!!screen.queryByRole("button", { name: /^order_query/ }), false);
  fireEvent.click(summary);
  assert.ok(screen.getByRole("button", { name: /^order_query/ }));
});
test("the overview keeps record order and scales width by receive span", () => {
  const records = projectTrajectory(events, "succeeded", false).flatMap((step) => step.records);
  const ordered = projectTimeline(records, "sequence")
    .flatMap((lane) => lane.spans)
    .sort((a, b) => a.left - b.left);
  assert.equal(ordered.length, records.length);
  for (let index = 1; index < ordered.length; index++)
    assert.ok(ordered[index].left >= ordered[index - 1].left);
  const tool = projectTimeline(records, "duration")
    .flatMap((lane) => lane.spans)
    .find((span) => span.record.kind === "tool");
  assert.ok(tool && tool.width > 0);
});
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
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /Runtime 事件产生时间/);
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
  assert.ok(screen.getAllByText("第 1 轮").length);
  assert.ok(screen.getAllByText("第 2 轮").length);
  assert.equal(!!screen.queryByText(/步骤/), false);
  fireEvent.click(screen.getByRole("button", { name: /^初始系统提示词/ }));
  fireEvent.click(screen.getByRole("tab", { name: "工具 (1)" }));
  assert.ok(screen.getAllByText("查询订单").length);
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /orderId/);
  assert.equal(!!screen.queryByRole("tab", { name: /事件/ }), false);
});

test("request retries retain their own failures and link reasoning, tools and timing to the successful attempt", () => {
  const request = (seq: number, index: number) =>
    event(seq, {
      type: "data-model-request",
      data: {
        requestIndex: index,
        stepIndex: 0,
        request: {
          model: "fixture",
          messages: [{ role: "user", content: "REQUEST_ONLY_NEEDLE" }],
          tools: [
            {
              type: "function",
              function: { name: "sum", description: "求和", parameters: { type: "object" } },
            },
          ],
        },
      },
    });
  const response = (seq: number, index: number, httpStatus: number): RunEvent => ({
    ...event(seq, { type: "data-model-response" }),
    observation: {
      type: "data-model-response",
      data: {
        requestIndex: index,
        httpStatus,
        startedAt: new Date(1000).toISOString(),
        responseAt: new Date(1100).toISOString(),
        firstByteAt: new Date(1120).toISOString(),
        completedAt: new Date(1300).toISOString(),
        durationMs: 300,
        firstByteMs: 120,
        responseBytes: 200,
        outcome: "completed",
      },
    },
  });
  const captured = [
    request(0, 1),
    response(1, 1, 503),
    request(2, 2),
    event(3, { type: "start-step" }),
    event(4, { type: "reasoning-start", id: "r" }),
    event(5, { type: "reasoning-delta", id: "r", delta: "先计算" }),
    event(6, { type: "reasoning-end", id: "r" }),
    event(7, {
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "sum",
      input: { values: [1, 2] },
    }),
    event(8, { type: "tool-output-available", toolCallId: "call-1", output: 3 }),
    response(9, 2, 200),
  ];
  const records = projectConversation({ run: baseRun, request: captured[0] }, [
    { number: 1, run: baseRun, events: captured, hasMoreEvents: false },
  ]);
  const requests = records.filter((r) => r.requestIndex !== undefined);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].status, "failed");
  assert.equal(requests[1].reasoning, "先计算");
  assert.equal(requests[1].modelTiming?.firstByteMs, 120);
  assert.equal(traceDuration(requests[1]), "300 ms");
  const tool = records.find((r) => r.kind === "tool");
  assert.equal(tool?.parentId, requests[1].id);
  assert.equal(tool?.tools?.[0].name, "sum");
  render(<ConversationTrajectory records={records} totalTurns={1} />);
  fireEvent.click(screen.getByRole("button", { name: "收起轮次" }));
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "REQUEST_ONLY_NEEDLE" } });
  assert.equal(screen.getAllByRole("button", { name: /^模型请求 #/ }).length, 2);
  fireEvent.click(screen.getByRole("button", { name: /^模型请求 #2/ }));
  fireEvent.click(screen.getByRole("tab", { name: "推理" }));
  assert.match(screen.getByRole("tabpanel").textContent ?? "", /先计算/);
});

test("the saved reply and terminal state survive missing stream events with explicit provenance", () => {
  const run = { ...baseRun, outputText: "已保存的历史答复", finishedAt: "2026-09-09T00:01:00Z" };
  const records = projectConversation({ run, request: null }, [
    {
      number: 1,
      run,
      events: [],
      hasMoreEvents: false,
      messages: [
        { id: "saved", role: "assistant", parts: [{ type: "text", text: run.outputText }] },
      ],
    },
  ]);
  assert.equal(records.find((r) => r.kind === "model")?.text, run.outputText);
  assert.match(records.find((r) => r.kind === "model")?.source ?? "", /无法还原中间过程/);
  assert.equal(records.find((r) => r.kind === "run")?.status, "succeeded");
  assert.ok(records.find((r) => r.kind === "run")?.coverage?.includes("实际模型请求未采集"));
  assert.equal(sessionLog(records).find((r) => r.kind === "model")?.messageId, "saved");
});

test("polling a selected record does not reset the user's reading position", () => {
  const records = projectConversation(null, [
    { number: 1, run: baseRun, events, hasMoreEvents: false },
  ]);
  const mounted = render(<ConversationTrajectory records={records} totalTurns={1} />);
  fireEvent.click(screen.getByRole("button", { name: /^order_query/ }));
  const list = screen.getByRole("region", { name: "多轮消息与调用" });
  list.scrollTop = 240;
  mounted.rerender(
    <ConversationTrajectory records={records.map((r) => ({ ...r }))} totalTurns={1} />,
  );
  assert.equal(list.scrollTop, 240);
});

test("incremental projection reuses unchanged turns without duplicating child links or mutating tool metadata", () => {
  const project = createConversationProjector();
  const initial = { run: { ...baseRun, registeredTools: [] }, request: null };
  const first = { number: 1, run: baseRun, events, hasMoreEvents: false };
  const second = { ...first, number: 2, run: { ...baseRun, id: "second" } };
  const expected = projectConversation(initial, [first, second]);
  const before = project(initial, [first]);
  const after = project(initial, [first, second]);
  assert.deepEqual(after, expected);
  assert.equal(
    before.find((r) => r.id === "run/user"),
    after.find((r) => r.id === "run/user"),
  );
  assert.deepEqual(project(initial, [first, second]), expected);
  assert.equal(initial.run.registeredTools.length, 0);
});
