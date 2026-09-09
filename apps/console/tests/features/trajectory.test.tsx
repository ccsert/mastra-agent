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
  fireEvent.click(screen.getByRole("button", { name: /order_query/ }));
  const inspector = screen.getByRole("region", { name: "轨迹记录详情" });
  assert.match(inspector.textContent ?? "", /synthetic-42/);
  assert.match(inspector.textContent ?? "", /订单服务超时/);
  fireEvent.change(screen.getByLabelText("搜索轨迹"), { target: { value: "knowledge" } });
  assert.equal(screen.queryByRole("button", { name: /order_query/ }), null);
  assert.ok(screen.getByRole("button", { name: /knowledge_search/ }));
});
