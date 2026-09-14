import assert from "node:assert/strict";
import test from "node:test";
import { createScriptQueue } from "../../apps/runtime/src/skills/script-queue.ts";

test("model batches execute sequentially; a failed call does not strand the queue", async () => {
  const enqueue = createScriptQueue(new AbortController().signal);
  const events: string[] = [];
  let active = 0,
    maximum = 0;
  const results = await Promise.allSettled(
    [1, 2, 3].map((id) =>
      enqueue(async () => {
        active++;
        maximum = Math.max(maximum, active);
        events.push(`start-${id}`);
        await Promise.resolve();
        active--;
        events.push(`end-${id}`);
        if (id === 2) throw new Error("fixture failure");
        return id;
      }),
    ),
  );
  assert.equal(maximum, 1);
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
});

test("queued calls never start after cancellation and queue depth stays bounded", async () => {
  const controller = new AbortController(),
    enqueue = createScriptQueue(controller.signal, 2);
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const first = enqueue(async () => {
    calls++;
    await barrier;
  });
  const second = enqueue(async () => {
    calls++;
  });
  await assert.rejects(
    enqueue(async () => {}),
    /SKILL_CALL_LIMIT/,
  );
  controller.abort(new Error("CANCELLED"));
  release();
  await first;
  await assert.rejects(second, /CANCELLED/);
  assert.equal(calls, 1);
});
