import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, RunEvent, TaskPlan } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { PlanOverview } from "../../src/features/runs/TrajectoryDetails.tsx";
import {
  foldTrace,
  projectConversation,
  projectTimeline,
  projectTrajectory,
  type TraceRecord,
} from "../../src/features/runs/trajectory.ts";
import { ToolResult } from "../../src/shared/ai/ToolResult.tsx";
import { AgentPlan } from "../../src/shared/assistant-ui/index.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
const plan: TaskPlan = {
  title: "订单核对",
  explanation: "等待数据源恢复",
  revision: 1,
  toolCallId: "plan-1",
  updatedAt: "2026-09-12T00:00:01Z",
  items: [
    { id: "a", title: "拉取订单", status: "blocked", detail: "数据源离线" },
    { id: "b", title: "核算金额", status: "in_progress" },
    { id: "c", title: "校验格式", status: "completed" },
    { id: "d", title: "发出报告", status: "cancelled" },
  ],
};
test("plan progress counts only explicitly completed items, including parallel and blocked tasks", () => {
  render(<AgentPlan title={plan.title} items={plan.items} />);
  assert.equal(screen.getByRole("progressbar").getAttribute("aria-valuenow"), "1");
  assert.equal(screen.getByRole("progressbar").getAttribute("aria-valuemax"), "4");
  assert.ok(screen.getByText("受阻"));
  assert.ok(screen.getByText("已取消"));
  assert.equal(document.querySelectorAll(".animate-spin").length, 0);
});
test("backend tool registry renders plans and unsuccessful subagents outside collapsed tool groups with trace links", async () => {
  globalThis.fetch = async () => Response.json({ skills: [] });
  render(
    <MemoryRouter>
      <ProjectData projectId="project">
        <Chat
          projectId="project"
          conversationId="conversation"
          onFinish={() => {}}
          messages={[
            {
              id: "answer",
              role: "assistant",
              metadata: { runId: "run" },
              parts: [
                {
                  type: "tool-update_plan",
                  toolCallId: "plan-1",
                  state: "output-available",
                  input: {},
                  output: plan,
                },
                {
                  type: "tool-delegate_task",
                  toolCallId: "delegate-1",
                  state: "output-available",
                  input: { name: "订单核对员", task: "读取远程数据" },
                  output: { subagentId: "child", status: "failed", errorCode: "CONNECTION_FAILED" },
                },
                { type: "text", text: "数据源不可用，请稍后重试" },
              ],
            },
          ]}
        />
      </ProjectData>
    </MemoryRouter>,
  );
  assert.ok(await screen.findByRole("region", { name: "任务计划版本 1" }));
  const child = await screen.findByRole("region", { name: "子代理 · 订单核对员" });
  assert.ok(within(child).getByText("执行失败"));
  assert.equal(child.getAttribute("data-failed"), "true");
  assert.equal(document.querySelectorAll('[data-slot="tool-group-root"]').length, 0);
  assert.match(
    within(child).getByRole("link", { name: "查看执行轨迹 →" }).getAttribute("href") ?? "",
    /view=trace&runId=run&recordId=run%2Ftool%3Adelegate-1/,
  );
});
test("persisted plan revisions keep the original snapshot and expose scope-local changes", () => {
  const next: TaskPlan = {
    ...plan,
    revision: 2,
    toolCallId: "plan-2",
    explanation: "数据源恢复",
    items: plan.items
      .filter((item) => item.id !== "d")
      .map((item) => ({ ...item, status: "completed" })),
  };
  const events: RunEvent[] = [plan, next].map((value, seq) => ({
    seq,
    createdAt: value.updatedAt,
    occurredAt: value.updatedAt,
    timeSource: "runtime",
    chunk: { type: "data-task-plan", data: value },
    observation: { type: "data-task-plan", data: value },
  }));
  const records = projectTrajectory(events, "succeeded", true).flatMap((step) => step.records);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.taskPlan?.items[0]?.status, "blocked");
  const current = records[1];
  assert.ok(current);
  let located = "";
  render(
    <PlanOverview
      record={current}
      records={records}
      onLocate={(id) => {
        located = id;
      }}
    />,
  );
  assert.ok(screen.getByText("受阻 → 已完成"));
  assert.ok(screen.getByText("从本版移除"));
  fireEvent.click(screen.getByRole("button", { name: "查看上一版计划 v1" }));
  assert.equal(located, records[0]?.id);
  assert.equal(
    projectTimeline(records, "sequence").find((lane) => lane.lane === "计划")?.spans.length,
    2,
  );
});
test("overlapping child calls occupy separate duration tracks while sequential calls reuse a track", () => {
  const records: TraceRecord[] = [
    [0, 5],
    [1, 4],
    [5, 8],
  ].map(([start, end], i) => ({
    id: String(i),
    kind: "agent",
    step: 1,
    title: String(i),
    status: "succeeded",
    text: "",
    events: [],
    startedAt: new Date((start ?? 0) * 1000).toISOString(),
    finishedAt: new Date((end ?? 0) * 1000).toISOString(),
  }));
  const lane = projectTimeline(records, "duration").find((l) => l.lane === "子代理");
  assert.equal(lane?.tracks, 2);
  assert.deepEqual(
    lane?.spans.map((s) => s.track),
    [0, 1, 0],
  );
  assert.equal(projectTimeline(records, "sequence").find((l) => l.lane === "子代理")?.tracks, 1);
});
test("missing previous plan history does not label existing items as newly added", () => {
  const record: TraceRecord = {
    id: "plan",
    kind: "plan",
    step: 1,
    title: "plan",
    status: "succeeded",
    text: "",
    events: [],
    startedAt: plan.updatedAt,
    taskPlan: { ...plan, revision: 3 },
  };
  render(<PlanOverview record={record} records={[record]} />);
  assert.ok(screen.getByText("尚未加载上一版计划，暂不判断任务变更。"));
  assert.equal(screen.queryByText("新增"), null);
});
test("script results preserve stderr and exit codes while rendering tabular JSON stdout", async () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({ name: `订单-${i + 1}`, amount: i }));
  render(
    <ToolResult
      toolName="run_skill_script"
      result={{
        entrypoint: "sum.py",
        stdout: JSON.stringify({ count: 23, rows }),
        stderr: "无法写入报告",
        exitCode: 2,
      }}
    />,
  );
  assert.ok(screen.getByText("退出码 2"));
  assert.ok(screen.getByText("count"));
  assert.ok(screen.getByText("无法写入报告"));
  assert.ok(screen.getByRole("columnheader", { name: "amount" }));
  assert.ok(screen.getByRole("cell", { name: "订单-1" }));
  assert.equal(screen.queryByRole("cell", { name: "订单-23" }), null);
  fireEvent.click(screen.getByTitle("2"));
  assert.ok(await screen.findByRole("cell", { name: "订单-23" }));
});

test("a plan tool remains attached to its originating model request after conversation projection", () => {
  const run: Run = {
    id: "run",
    conversationId: "conversation",
    releaseId: "release",
    releaseVersion: 1,
    agentName: "planner",
    runtimeId: "local",
    status: "succeeded",
    createdAt: plan.updatedAt,
    finishedAt: plan.updatedAt,
    errorCode: null,
    inputText: "plan",
    agentInstructions: "",
    registeredTools: [],
    selectedSkills: [],
    outputText: "done",
  };
  const chunks: RunEvent["chunk"][] = [
    {
      type: "data-model-request",
      data: {
        requestIndex: 1,
        stepIndex: 0,
        request: { model: "fixture", messages: [], tools: [] },
      },
    },
    { type: "start-step" },
    {
      type: "tool-input-available",
      toolCallId: plan.toolCallId,
      toolName: "update_plan",
      input: {},
    },
    { type: "tool-output-available", toolCallId: plan.toolCallId, output: plan },
    { type: "data-task-plan", data: plan },
  ];
  const events: RunEvent[] = chunks.map((chunk, seq) => ({
    seq,
    chunk,
    createdAt: plan.updatedAt,
    occurredAt: plan.updatedAt,
    timeSource: "runtime",
    ...(chunk.type === "data-task-plan"
      ? { observation: { type: "data-task-plan" as const, data: plan } }
      : {}),
  }));
  const records = projectConversation(null, [{ number: 1, run, events, hasMoreEvents: false }]);
  const record = records.find((r) => r.kind === "plan"),
    request = records.find((r) => r.requestIndex === 1);
  assert.ok(record);
  assert.ok(request);
  assert.equal(record.parentId, request.id);
  assert.ok(request.childIds?.includes(record.id));
  assert.ok(
    !foldTrace(records, { turns: new Set(), calls: new Set([request.id]) }).some(
      (r) => r.id === record.id,
    ),
  );
});
