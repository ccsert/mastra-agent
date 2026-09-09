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
  fireEvent.click(await screen.findByRole("button", { name: "加载第 1 轮后续调用" }));
  await screen.findByText("进行中结果");
  finished = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新会话" }));
  await screen.findByText("最终结果");
  assert.ok(tailReads >= 2);
  assert.equal(!!screen.queryByText("未完成"), false);
});
