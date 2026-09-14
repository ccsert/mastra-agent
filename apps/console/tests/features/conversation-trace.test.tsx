import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Run, ConversationTrace as Trace } from "@platform/sdk";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";
import { ConversationTrace } from "../../src/features/runs/ConversationTrace";
import { ProjectData, useProjectRefresh } from "../../src/shared/data/ProjectData";

afterEach(cleanup);
const run: Run = {
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
function page(number: number, nextBefore: number | null = null): Trace {
  return {
    initial: { run, request: null },
    totalTurns: 2,
    nextBefore,
    turns: [
      {
        number,
        run: { ...run, id: `run-${number}`, inputText: `第${number}轮的问题` },
        events: [],
        hasMoreEvents: false,
      },
    ],
  };
}
function Content({ projectId, conversationId }: { projectId: string; conversationId: string }) {
  const refresh = useProjectRefresh();
  return (
    <>
      <button type="button" onClick={() => void refresh("conversations")}>
        刷新会话
      </button>
      <ConversationTrace projectId={projectId} conversationId={conversationId} />
    </>
  );
}
function view(projectId: string, conversationId = "conversation") {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectData key={projectId} projectId={projectId}>
        <Content key={conversationId} projectId={projectId} conversationId={conversationId} />
      </ProjectData>
    </ConfigProvider>
  );
}
test("conversation paging merges older turns and aborts stale responses when switching project", async (t) => {
  let fail = true;
  let pending: Request | undefined;
  let resolve!: (r: Response) => void;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.pathname.includes("/B/"))
      return Response.json({
        ...page(1),
        turns: [{ ...page(1).turns[0], run: { ...run, inputText: "项目 B 会话" } }],
      });
    if (url.pathname.includes("/slow/")) {
      pending = request;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }
    if (url.searchParams.has("before")) {
      assert.equal(url.searchParams.get("before"), "2");
      return fail
        ? Response.json({ message: "合成分页故障" }, { status: 503 })
        : Response.json(page(1));
    }
    return Response.json(page(2, 2));
  });
  const mounted = render(view("A"));
  await screen.findByText("第2轮的问题");
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("会话轨迹加载失败");
  assert.ok(screen.getByText("第2轮的问题"));
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("第1轮的问题");
  assert.equal(screen.getAllByRole("button", { name: /^用户输入/ }).length, 2);
  mounted.rerender(view("A", "slow"));
  await waitFor(() => assert.ok(pending));
  mounted.rerender(view("B"));
  await screen.findByText("项目 B 会话");
  assert.equal(pending?.signal.aborted, true);
  await act(async () => resolve(Response.json(page(2))));
  assert.equal(!!screen.queryByText("第2轮的问题"), false);
});
test("finishing a long streamed turn refreshes its tail before marking model output complete", async (t) => {
  let finished = false,
    tailReads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.pathname.endsWith("/events")) {
      tailReads++;
      assert.equal(url.searchParams.get("after"), "1");
      return Response.json([
        {
          seq: 2,
          chunk: { type: "text-delta", id: "txt", delta: finished ? "最终结果" : "进行中结果" },
          createdAt: run.createdAt,
        },
        ...(finished
          ? [{ seq: 3, chunk: { type: "text-end", id: "txt" }, createdAt: run.createdAt }]
          : []),
      ]);
    }
    return Response.json({
      initial: { run, request: null },
      totalTurns: 1,
      nextBefore: null,
      turns: [
        {
          number: 1,
          run: { ...run, status: finished ? "succeeded" : "running" },
          hasMoreEvents: true,
          events: [
            { seq: 0, chunk: { type: "start-step" }, createdAt: run.createdAt },
            { seq: 1, chunk: { type: "text-start", id: "txt" }, createdAt: run.createdAt },
          ],
        },
      ],
    });
  });
  render(view("A"));
  // The newest turn now follows its tail automatically, including after completion.
  await screen.findByText("进行中结果");
  finished = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
  await screen.findByText("最终结果");
  assert.ok(tailReads >= 2);
  assert.equal(!!screen.queryByText("未完成"), false);
});

test("settled long conversations do not reload already loaded pages on a polling timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reads: number[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const before = Number(url.searchParams.get("before") ?? 81);
    reads.push(before);
    return Response.json({ ...page(before - 1, before > 2 ? before - 1 : null), totalTurns: 80 });
  });
  render(view("settled-pages"));
  await screen.findByText("第80轮的问题");
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("第79轮的问题");
  const readCount = reads.length;
  await act(async () => {
    t.mock.timers.tick(3100);
  });
  assert.equal(reads.length, readCount, "已完成的会话不应每三秒从头重读所有历史分页");
});

test("opening a long conversation bounds simultaneous tail reads", async (t) => {
  const pending: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/events")) {
      pending.push(request);
      return new Promise<Response>((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    }
    return Response.json({
      initial: { run, request: null },
      totalTurns: 80,
      nextBefore: 71,
      turns: Array.from({ length: 10 }, (_, index) => ({
        ...page(71 + index).turns[0],
        hasMoreEvents: true,
      })),
    });
  });
  render(view("bounded-tails"));
  await waitFor(() => assert.ok(pending.length > 0));
  assert.ok(
    pending.length <= 3,
    `初次进入并发读取了 ${pending.length} 轮完整尾部，应限制在 3 轮以内`,
  );
});

test("live polling updates only the head and preserves pages already read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reads: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const before = new URL(new Request(input, init).url).searchParams.get("before");
    reads.push(before);
    const data = before ? page(79, 79) : page(80, 80);
    return Response.json({
      ...data,
      totalTurns: 80,
      turns: data.turns.map((turn) => ({
        ...turn,
        run: { ...turn.run, status: before ? "succeeded" : "running" },
      })),
    });
  });
  render(view("live-head"));
  await screen.findByText("第80轮的问题");
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("第79轮的问题");
  const headReads = reads.filter((before) => before === null).length;
  await act(async () => {
    t.mock.timers.tick(3100);
  });
  await waitFor(() =>
    assert.equal(reads.filter((before) => before === null).length, headReads + 1),
  );
  assert.equal(reads.filter((before) => before !== null).length, 1);
  assert.ok(screen.getByText("第79轮的问题"));
});

test("an older active turn outside the newest page still reaches its terminal state without polling settled history", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finished = false;
  const reads: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const before = new URL(new Request(input, init).url).searchParams.get("before");
    reads.push(before);
    const number = before === null ? 20 : Number(before) - 1;
    const data = page(number, number);
    return Response.json({
      ...data,
      totalTurns: 20,
      turns: data.turns.map((turn) => ({
        ...turn,
        run: { ...turn.run, status: number === 19 && !finished ? "running" : "succeeded" },
      })),
    });
  });
  render(view("older-active"));
  await screen.findByText("第20轮的问题");
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("第19轮的问题");
  fireEvent.click(screen.getByRole("button", { name: "加载更早轮次" }));
  await screen.findByText("第18轮的问题");
  finished = true;
  await act(async () => {
    t.mock.timers.tick(3100);
  });
  await waitFor(() => assert.ok(reads.filter((before) => before === "20").length === 2));
  await waitFor(() =>
    assert.equal(screen.queryAllByRole("button", { name: /本轮运行.*运行中/ }).length, 0),
  );
  assert.equal(reads.filter((before) => before === "19").length, 1);
});
