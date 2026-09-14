import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTrace, Run, RunEvent, TraceTurn } from "@platform/sdk";
import { loadFullTrace, loadTraceTail } from "../../src/features/runs/trace-loading";

const run: Run = {
  id: "run",
  conversationId: "conversation",
  releaseId: "release",
  releaseVersion: 1,
  agentName: "Agent",
  runtimeId: "runtime",
  createdAt: "2026-09-12T00:00:00Z",
  finishedAt: null,
  status: "running",
  errorCode: null,
  inputText: "input",
  agentInstructions: "system",
  registeredTools: [],
  selectedSkills: [],
  outputText: null,
};
const event = (seq: number): RunEvent => ({
  seq,
  chunk: { type: "text-delta", id: "text", delta: "片段" },
  createdAt: run.createdAt,
  occurredAt: run.createdAt,
  timeSource: "runtime",
});
const turn = (number: number, count: number): TraceTurn => ({
  number,
  run: { ...run, id: `run-${number}` },
  events: Array.from({ length: Math.min(count, 500) }, (_, i) => event(i)),
  hasMoreEvents: count > 500,
  checkpoint: { eventCount: count, lastSeq: count - 1, capturedAt: run.createdAt },
});
const page = (turns: TraceTurn[], nextBefore: number | null): ConversationTrace => ({
  initial: { run, request: null },
  totalTurns: 2,
  turns,
  nextBefore,
});

test("complete trace reads every turn and bounds a growing live tail at its checkpoint", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/events")) {
      assert.equal(url.searchParams.get("after"), "499");
      assert.equal(url.searchParams.get("through"), "502");
      return Response.json([event(500), event(501), event(502)]);
    }
    return Response.json(
      url.searchParams.has("before") ? page([turn(1, 1)], null) : page([turn(2, 503)], 2),
    );
  });
  const progress: number[] = [];
  const full = await loadFullTrace("A", "conversation", new AbortController().signal, (n) =>
    progress.push(n),
  );
  assert.deepEqual(
    full.turns.map((t) => [t.number, t.events.length, t.hasMoreEvents]),
    [
      [1, 1, false],
      [2, 503, false],
    ],
  );
  assert.deepEqual(progress, [1, 2]);
  assert.equal(calls.length, 3);
  assert.equal(full.turns[1].run.status, "running");
});

test("a short or stalled tail cannot be exported as complete", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([]));
  await assert.rejects(loadTraceTail("A", turn(1, 503), new AbortController().signal), /不完整/);
  t.mock.method(globalThis, "fetch", async () => Response.json([event(499)]));
  await assert.rejects(loadTraceTail("A", turn(1, 503), new AbortController().signal), /没有前进/);
});

test("merged delta batches keep paging to the checkpoint while legacy reads end on a short batch", async (t) => {
  const calls: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    assert.equal(url.searchParams.get("compact"), "deltas");
    const after = Number(url.searchParams.get("after"));
    const bound = url.searchParams.get("through");
    const through = bound === null ? Infinity : Number(bound);
    calls.push(after);
    // 500 raw events compact into three merged chunks per page.
    return Response.json([
      { ...event(after + 1), seq: Math.min(through, after + 300) },
      { ...event(after + 1), seq: Math.min(through, after + 450) },
      { ...event(after + 1), seq: Math.min(through, after + 500) },
    ]);
  });
  const merged = await loadTraceTail("A", turn(1, 1501), new AbortController().signal);
  assert.equal(merged.at(-1)?.seq, 1500);
  assert.ok(calls.length >= 2, "压缩后的短批次必须继续读取到 checkpoint");
  const legacy = await loadTraceTail(
    "A",
    { ...turn(1, 1501), checkpoint: undefined },
    new AbortController().signal,
  );
  assert.equal(legacy.length, 3);
});

test("cancelling a full read aborts its fetch and prevents a completed snapshot", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    controller.abort();
    assert.equal(request.signal.aborted, true);
    return Response.json(page([turn(1, 1), turn(2, 1)], null));
  });
  await assert.rejects(
    loadFullTrace("A", "conversation", controller.signal, () => {}),
    { name: "AbortError" },
  );
});

test("tail reads publish useful partial content before the final batch and resume at the last checkpoint", async (t) => {
  const { createTraceReader } = await import("../../src/features/runs/trace-reader");
  const reader = createTraceReader();
  const reads: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const after = Number(url.searchParams.get("after"));
    const through = Number(url.searchParams.get("through"));
    reads.push(after);
    return Response.json(
      Array.from({ length: Math.min(500, through - after) }, (_, i) => event(after + 1 + i)),
    );
  });
  const progress: number[] = [];
  await reader.read("A", turn(1, 1100), new AbortController().signal, (events) =>
    progress.push(events.length),
  );
  assert.ok(progress.includes(500), "尾页全部到齐前必须能浏览已读取事件");
  const next = await reader.read("A", turn(1, 1105), new AbortController().signal, () => {});
  assert.deepEqual(reads, [499, 999, 1099]);
  assert.equal(next.length, 605);
  assert.equal(next.at(-1)?.seq, 1104);
});

test("aborting a queued tail never starts its HTTP request", async (t) => {
  const { createTraceReader } = await import("../../src/features/runs/trace-reader");
  const reader = createTraceReader(1);
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
  });
  const first = new AbortController(),
    queued = new AbortController();
  const a = reader.read("A", turn(1, 501), first.signal, () => {});
  const b = reader.read("A", turn(2, 501), queued.signal, () => {});
  queued.abort();
  await assert.rejects(b, { name: "AbortError" });
  first.abort();
  await assert.rejects(a, { name: "AbortError" });
  assert.ok(paths.every((path) => path.includes("run-1")));
});

test("an 80-turn complete read crosses every page and publishes completed turns in order of arrival", async (t) => {
  let pages = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const before = Number(url.searchParams.get("before") ?? 81);
    const first = Math.max(1, before - 20);
    pages++;
    return Response.json({
      ...page(
        Array.from({ length: before - first }, (_, i) => turn(first + i, 1)),
        first > 1 ? first : null,
      ),
      totalTurns: 80,
    });
  });
  const progress: number[] = [];
  const full = await loadFullTrace(
    "A",
    "conversation",
    new AbortController().signal,
    (loaded, total, snapshot) => {
      assert.equal(total, 80);
      assert.equal(snapshot.turns.length, loaded);
      progress.push(loaded);
    },
  );
  assert.equal(pages, 4);
  assert.equal(full.turns.length, 80);
  assert.deepEqual(
    full.turns.map((t) => t.number),
    Array.from({ length: 80 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    progress,
    Array.from({ length: 80 }, (_, i) => i + 1),
  );
});
