import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import { MemoryRouter } from "react-router";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
function chat(messages: UIMessage[]) {
  return (
    <MemoryRouter>
      <ProjectData projectId="project">
        <Chat
          projectId="project"
          conversationId="density"
          messages={messages}
          onFinish={() => {}}
        />
      </ProjectData>
    </MemoryRouter>
  );
}

test("reasoning and each tool expose useful previews and open directly without an outer call-count disclosure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills: [] }));
  render(
    chat([
      {
        id: "answer",
        role: "assistant",
        metadata: { runId: "run" },
        parts: [
          { type: "reasoning", text: "**先读取订单**\n\n再核对两组金额。" },
          {
            type: "tool-run_skill_script",
            toolCallId: "script",
            state: "output-available",
            input: { entrypoint: "summary.mjs" },
            output: {
              entrypoint: "summary.mjs",
              exitCode: 0,
              stdout: '[{"id":"A","amount":10}]',
              stderr: "",
            },
          },
          {
            type: "tool-sum_values",
            toolCallId: "sum",
            state: "output-available",
            input: { values: [3, 7] },
            output: { total: 10 },
          },
          { type: "text", text: "核对完成。" },
        ],
      },
    ]),
  );
  const thought = await screen.findByRole("button", { name: /思考.*先读取订单/ });
  assert.equal(thought.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("再核对两组金额。"), null);
  const script = screen.getByRole("button", { name: /执行脚本.*summary.mjs.*退出码 0/ });
  assert.ok(screen.getByRole("button", { name: /计算.*3 \+ 7.*→ 10/ }));
  assert.equal(screen.queryByRole("columnheader", { name: "amount" }), null);
  assert.equal(screen.queryByRole("button", { name: /次工具调用/ }), null);
  fireEvent.click(script);
  assert.ok(await screen.findByRole("columnheader", { name: "amount" }));
  assert.ok(screen.getByRole("cell", { name: "A" }));
  fireEvent.click(thought);
  assert.ok(await screen.findByText("再核对两组金额。"));
  assert.equal(thought.getAttribute("aria-expanded"), "true");
  assert.match(
    screen.getAllByRole("link", { name: "查看执行轨迹 →" })[0]?.getAttribute("href") ?? "",
    /recordId=run%2Ftool%3Ascript/,
  );
});

test("knowledge citations remain readable through the tool row and failed tools stay identifiable when collapsed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills: [] }));
  render(
    chat([
      {
        id: "answer",
        role: "assistant",
        parts: [
          {
            type: "tool-knowledge_search",
            toolCallId: "search",
            state: "output-available",
            input: { query: "退货规则" },
            output: {
              sources: [
                {
                  citationId: "source-1",
                  filename: "退货说明.md",
                  ordinal: 0,
                  content: "收到商品七日内可申请。",
                },
              ],
            },
          },
          {
            type: "tool-remote_lookup",
            toolCallId: "failed",
            state: "output-error",
            input: { query: "远程订单" },
            errorText: "CONNECTION_FAILED",
          },
        ],
      },
    ]),
  );
  const search = await screen.findByRole("button", { name: /检索知识.*退货规则.*1 个来源/ });
  const failed = screen.getByRole("button", { name: /remote_lookup.*远程订单.*执行失败/ });
  assert.equal(failed.getAttribute("aria-expanded"), "false");
  fireEvent.click(failed);
  assert.ok(await screen.findByText("CONNECTION_FAILED"));
  fireEvent.click(search);
  const sources = await screen.findByRole("region", { name: "知识库来源" });
  fireEvent.click(within(sources).getByText(/退货说明.md/));
  assert.ok(within(sources).getByText("收到商品七日内可申请。"));
});

test("streamed reasoning remains collapsed and preserves manual disclosure state through completion", async (t) => {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter(),
    encoder = new TextEncoder();
  async function emit(chunk: unknown) {
    await act(async () => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    });
  }
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/chat"))
      return new Response(stream.readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "x-platform-run-id": "run",
        },
      });
    throw new Error(`Unexpected ${url}`);
  });
  render(chat([]));
  fireEvent.change(await screen.findByRole("textbox", { name: "消息" }), {
    target: { value: "核对订单" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await emit({ type: "start", messageId: "stream" });
  await emit({ type: "reasoning-start", id: "reasoning" });
  await emit({ type: "reasoning-delta", id: "reasoning", delta: "先读取订单" });
  let trigger = await screen.findByRole("button", { name: /思考中.*先读取订单/ });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  await emit({ type: "reasoning-delta", id: "reasoning", delta: "\n再核对金额" });
  trigger = await screen.findByRole("button", { name: /思考中.*再核对金额/ });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  await emit({ type: "reasoning-delta", id: "reasoning", delta: "\n两项均已完成" });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  fireEvent.click(trigger);
  await emit({ type: "reasoning-end", id: "reasoning" });
  await emit({ type: "text-start", id: "body" });
  await emit({ type: "text-delta", id: "body", delta: "已核对。" });
  await emit({ type: "text-end", id: "body" });
  await emit({ type: "finish" });
  await act(async () => {
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
  });
  trigger = await screen.findByRole("button", { name: /思考.*先读取订单/ });
  await waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "false"));
  assert.ok(screen.getByText("已核对。"));
});

test("a completed subagent previews its outcome and opens readable content before raw records", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills: [] }));
  render(
    chat([
      {
        id: "answer",
        role: "assistant",
        parts: [
          {
            type: "tool-delegate_task",
            toolCallId: "child",
            state: "output-available",
            input: { name: "核算员", task: "读取两组数据并核对" },
            output: {
              status: "succeeded",
              text: "### 核对结果\n\n总额为 **10**。",
              subagentId: "child-id",
            },
          },
        ],
      },
    ]),
  );
  const region = await screen.findByRole("region", { name: "子代理 · 核算员" });
  const trigger = within(region).getByRole("button", { name: /子代理.*核算员.*总额为 10.*已完成/ });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(within(region).queryByRole("heading", { name: "核对结果" }), null);
  fireEvent.click(trigger);
  assert.ok(await within(region).findByRole("heading", { name: "核对结果" }));
  assert.ok(within(region).getByText("读取两组数据并核对"));
  assert.equal(
    within(region)
      .getByText(/"subagentId"/)
      .closest("details")?.open,
    false,
  );
});
