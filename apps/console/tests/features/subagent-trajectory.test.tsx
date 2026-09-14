import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, RunEvent, SubagentLifecycle } from "@platform/sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationTrajectory } from "../../src/features/runs/ConversationTrajectory.tsx";
import {
  foldTrace,
  projectConversation,
  unfoldTarget,
} from "../../src/features/runs/trajectory.ts";

afterEach(cleanup);
const root = "00000000-0000-4000-8000-000000000001";
const at = (n: number) => new Date(1000 + n * 100).toISOString();
const run: Run = {
  id: root,
  conversationId: "conversation",
  releaseId: "release",
  releaseVersion: 1,
  agentName: "parent",
  runtimeId: "runtime",
  status: "succeeded",
  createdAt: at(0),
  finishedAt: at(100),
  errorCode: null,
  inputText: "并行核对",
  agentInstructions: "rules",
  registeredTools: [],
  selectedSkills: [],
  outputText: "汇总",
};
function records() {
  let seq = 0;
  const events: RunEvent[] = [];
  const add = (chunk: RunEvent["chunk"], observation?: RunEvent["observation"]) => {
    events.push({
      seq,
      chunk,
      observation,
      occurredAt: at(seq),
      createdAt: at(seq),
      timeSource: "runtime",
    });
    seq++;
  };
  add({
    type: "data-model-request",
    data: { requestIndex: 1, stepIndex: 0, request: { model: "fixture", messages: [] } },
  });
  add({ type: "start-step" });
  for (const name of ["A", "B"])
    add({
      type: "tool-input-available",
      toolCallId: `parent-${name}`,
      toolName: "delegate_task",
      input: { name, task: `任务 ${name}` },
    });
  for (const [i, name] of ["A", "B"].entries()) {
    const state: SubagentLifecycle = {
      id: `00000000-0000-4000-8000-00000000000${i + 2}`,
      parentRunId: root,
      parentToolCallId: `parent-${name}`,
      name,
      task: `任务 ${name}`,
      status: "succeeded",
      queuedAt: at(3),
      startedAt: at(4),
      finishedAt: at(90),
      maxSteps: 3,
      depth: 1,
      modelId: "fixture",
      allowedTools: ["sum"],
      outputText: `子结果 ${name}`,
    };
    add({ type: "data-subagent" }, { type: "data-subagent", data: state });
    const child = (chunk: RunEvent["chunk"]) =>
      add(
        { type: "data-subagent-event" },
        {
          type: "data-subagent-event",
          data: {
            id: state.id,
            parentToolCallId: state.parentToolCallId,
            occurredAt: at(seq),
            chunk,
          },
        },
      );
    child({
      type: "data-model-request",
      data: {
        requestIndex: 1,
        stepIndex: 0,
        request: { model: "fixture", messages: [{ role: "user", content: `任务 ${name}` }] },
      },
    });
    child({ type: "start-step" });
    child({ type: "text-start", id: "same-message-id" });
    child({ type: "text-delta", id: "same-message-id", delta: `子结果 ${name}` });
    child({ type: "text-end", id: "same-message-id" });
    child({
      type: "tool-input-available",
      toolCallId: "same-tool-id",
      toolName: "sum",
      input: { source: name },
    });
    child({ type: "tool-output-available", toolCallId: "same-tool-id", output: `证据 ${name}` });
  }
  return projectConversation(null, [{ number: 1, run, events, hasMoreEvents: false }]);
}

test("parallel children retain independent identities, data and all ancestor links", () => {
  const projected = records();
  const children = projected.filter((r) => r.kind === "agent");
  assert.equal(children.length, 2);
  const tools = projected.filter((r) => r.toolCallId === "same-tool-id");
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].id, tools[1].id);
  assert.notEqual(tools[0].parentId, tools[1].parentId);
  assert.deepEqual(
    tools.map((t) => t.output),
    ["证据 A", "证据 B"],
  );
  assert.ok(tools.every((t) => t.runId === root && t.messageId === undefined));
  const parent = projected.find((r) => r.requestIndex === 1 && !r.scopeId);
  assert.ok(parent);
  const folded = foldTrace(projected, { turns: new Set(), calls: new Set([parent.id]) });
  assert.equal(
    folded.some((r) => r.scopeId),
    false,
  );
  assert.equal(
    folded.some((r) => r.kind === "agent"),
    false,
  );
  const target = unfoldTarget(projected, tools[1].id);
  assert.equal(target.calls?.length, 3);
  assert.equal(target.calls?.at(-1), parent.id);
});

test("deep search retains its full path and clicking the timeline opens every ancestor", () => {
  const projected = records();
  const view = render(<ConversationTrajectory records={projected} totalTurns={1} />);
  fireEvent.click(screen.getByRole("button", { name: "收起调用" }));
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "证据 B" } });
  assert.ok(screen.getByRole("button", { name: "子代理 · B · 第 1 轮 · 完成" }));
  assert.ok(screen.getByRole("button", { name: "sum · B · 第 1 轮 · 完成" }));
  fireEvent.click(screen.getByRole("button", { name: "sum · B · 第 1 轮 · 完成" }));
  assert.match(screen.getByRole("region", { name: "轨迹记录详情" }).textContent ?? "", /证据 B/);
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "" } });
  assert.ok(screen.getByRole("button", { name: "sum · B · 第 1 轮 · 完成" }));
  fireEvent.click(screen.getByRole("button", { name: "收起调用" }));
  view.rerender(
    <ConversationTrajectory records={projected.map((r) => ({ ...r }))} totalTurns={1} />,
  );
  assert.equal(screen.queryByRole("button", { name: "sum · B · 第 1 轮 · 完成" }), null);
  fireEvent.click(screen.getByRole("button", { name: "定位 sum · B · 第 1 轮" }));
  assert.ok(screen.getByRole("button", { name: "sum · B · 第 1 轮 · 完成" }));
});
