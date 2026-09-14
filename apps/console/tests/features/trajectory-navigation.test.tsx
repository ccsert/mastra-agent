import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render as mount, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";
import { ConversationTrajectory } from "../../src/features/runs/ConversationTrajectory";
import { TrajectoryTimeline } from "../../src/features/runs/TrajectoryTimeline";
import {
  FULL_TIMELINE,
  panTimeline,
  timelineWindow,
  zoomTimeline,
} from "../../src/features/runs/timeline-window";
import { projectTimeline, type TraceRecord } from "../../src/features/runs/trajectory";

afterEach(cleanup);
const render = (node: React.ReactNode) =>
  mount(<ConfigProvider theme={{ token: { motion: false } }}>{node}</ConfigProvider>);
function records(count: number): TraceRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `record-${index}`,
    step: index,
    turn: Math.floor(index / 100) + 1,
    kind: index % 100 === 0 ? "user" : index % 2 ? "model" : "tool",
    title: `记录 ${index}`,
    status: "succeeded",
    startedAt: new Date(index * 10).toISOString(),
    text: `内容 ${index}`,
    events: [],
  }));
}
test("80 turns of dense records keep both timeline and list DOM bounded and zoom restores targets", () => {
  render(<ConversationTrajectory records={records(8000)} totalTurns={80} />);
  assert.ok(document.querySelectorAll(".trace-row").length < 50);
  assert.ok(document.querySelectorAll(".trace-segment").length < 700);
  const cluster = screen.getAllByRole("button", { name: /缩放查看/ })[0];
  fireEvent.click(cluster);
  assert.notEqual(screen.getByLabelText("时间轴缩放比例").textContent, "1.0×");
  assert.ok(screen.getAllByRole("button", { name: /^定位 记录/ }).length > 0);
  fireEvent.click(screen.getByRole("button", { name: "复位" }));
  assert.equal(screen.getByLabelText("时间轴缩放比例").textContent, "1.0×");
});
test("brush selection locates its first record, focuses, resets and cancels without accidental clicks", () => {
  const chosen: string[] = [];
  render(
    <TrajectoryTimeline
      timeline={projectTimeline(records(40), "sequence")}
      mode="sequence"
      onSelect={(id) => chosen.push(id)}
    />,
  );
  const plot = screen.getByRole("group", { name: "时间轴，拖动框选，滚轮缩放" });
  // jsdom has no PointerEvent constructor; use a MouseEvent carrying pointer coordinates.
  const pointer = (type: string, x: number) =>
    fireEvent(plot, new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }));
  pointer("pointerdown", 600);
  pointer("pointermove", 200);
  pointer("pointerup", 200);
  assert.ok(chosen.length === 1);
  assert.match(screen.getByText(/已框选/).textContent ?? "", /已框选 \d+ 条记录/);
  fireEvent.click(screen.getByRole("button", { name: "聚焦选区" }));
  assert.equal(screen.getByLabelText("时间轴缩放比例").textContent, "2.0×");
  pointer("pointerdown", 0);
  pointer("pointermove", 40);
  pointer("pointercancel", 40);
  assert.equal(chosen.length, 1);
  fireEvent.keyDown(plot, { key: "Home" });
  assert.equal(screen.getByLabelText("时间轴缩放比例").textContent, "1.0×");
  fireEvent.wheel(plot, { deltaY: -175, clientX: 400 });
  assert.notEqual(screen.getByLabelText("时间轴缩放比例").textContent, "1.0×");
  fireEvent.keyDown(plot, { key: "Home" });
  fireEvent.keyDown(plot, { key: "+" });
  assert.equal(screen.getByLabelText("时间轴缩放比例").textContent, "2.0×");
});
test("filtering or folding after scrolling deep never leaves a blank virtual window", () => {
  render(<ConversationTrajectory records={records(800)} totalTurns={8} />);
  const list = screen.getByRole("region", { name: "多轮消息与调用" });
  fireEvent.scroll(list, { target: { scrollTop: 42_000 } });
  fireEvent.click(screen.getByRole("button", { name: "工具" }));
  assert.ok(document.querySelectorAll(".trace-row").length > 0);
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  fireEvent.click(screen.getByRole("button", { name: "收起轮次" }));
  assert.ok(screen.getAllByRole("button", { name: /展开第 \d+ 轮 ·/ }).length === 8);
});
test("zoom preserves the cursor anchor and panning clamps at both edges", () => {
  assert.deepEqual(zoomTimeline(FULL_TIMELINE, 0.5, 0.25), { start: 12.5, end: 62.5 });
  assert.deepEqual(panTimeline({ start: 20, end: 40 }, -10), { start: 0, end: 20 });
  assert.deepEqual(panTimeline({ start: 20, end: 40 }, 10), { start: 80, end: 100 });
  assert.deepEqual(timelineWindow(60, 20), { start: 20, end: 60 });
  assert.ok(
    zoomTimeline(FULL_TIMELINE, 0.00001).end - zoomTimeline(FULL_TIMELINE, 0.00001).start >=
      0.04999,
  );
});
