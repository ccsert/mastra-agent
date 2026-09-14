import assert from "node:assert/strict";
import test from "node:test";
import { createPlanTracker } from "../../apps/runtime/src/agents/planning.ts";
import { PlanUpdate, TaskPlan } from "../../packages/contracts/src/index.ts";

const input = PlanUpdate.parse({
  baseRevision: 0,
  title: "核对订单",
  explanation: "先分配任务",
  items: [
    { id: "a", title: "读取订单", status: "in_progress" },
    { id: "b", title: "确认金额", status: "pending" },
  ],
});
test("plans preserve explicit independent states and immutable history with actual call IDs", async () => {
  const events: unknown[] = [];
  const tracker = createPlanTracker(async (chunk) => {
    events.push(chunk);
  });
  const first = await tracker.update(input, "call-1");
  const next = await tracker.update(
    {
      ...input,
      baseRevision: 1,
      explanation: "数据源不可用",
      items: [
        { id: "a", title: "读取订单", status: "blocked", detail: "连接失败" },
        { id: "b", title: "确认金额", status: "cancelled" },
      ],
    },
    "call-2",
  );
  assert.equal(first.revision, 1);
  assert.equal(first.items[0]?.status, "in_progress");
  assert.equal(next.revision, 2);
  assert.equal(next.toolCallId, "call-2");
  assert.equal(next.items[0]?.status, "blocked");
  assert.equal(events.length, 2);
  assert.ok(TaskPlan.safeParse(next).success);
});
test("parallel plan writes reject stale revisions and permit an explicit retry", async () => {
  let count = 0;
  const tracker = createPlanTracker(async () => {
    count++;
  });
  const results = await Promise.allSettled([
    tracker.update(input, "a"),
    tracker.update(input, "b"),
  ]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  if (results[1]?.status === "rejected")
    assert.match(String(results[1].reason), /PLAN_REVISION_CONFLICT/);
  assert.equal(count, 1);
  assert.equal((await tracker.update({ ...input, baseRevision: 1 }, "retry")).revision, 2);
});
test("invalid identities and failed persistence never advance a plan", async () => {
  let fail = true;
  const tracker = createPlanTracker(async () => {
    if (fail) throw new Error("write failed");
  });
  await assert.rejects(tracker.update(input, ""), /PLAN_CALL_ID_REQUIRED/);
  const first = input.items[0];
  assert.ok(first);
  await assert.rejects(
    tracker.update({ ...input, items: [first, first] }, "duplicate"),
    /PLAN_DUPLICATE_ITEM_ID/,
  );
  await assert.rejects(tracker.update(input, "failed"), /write failed/);
  fail = false;
  assert.equal((await tracker.update(input, "retry")).revision, 1);
  const child = createPlanTracker(async () => {});
  assert.equal((await child.update(input, "child")).revision, 1);
  assert.equal((await tracker.update({ ...input, baseRevision: 1 }, "parent")).revision, 2);
});
