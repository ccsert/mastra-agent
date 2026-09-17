import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);

/** Two completed turns of history, enough for the recall ring to have depth. */
const history = [
  { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "第一轮问题" }] },
  { id: "a1", role: "assistant" as const, parts: [{ type: "text" as const, text: "第一轮回答" }] },
  { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "第二轮问题" }] },
  { id: "a2", role: "assistant" as const, parts: [{ type: "text" as const, text: "第二轮回答" }] },
];

function renderChat() {
  globalThis.fetch = async () => Response.json({ skills: [] });
  render(
    <ProjectData projectId="project">
      <Chat projectId="project" conversationId="history" messages={history} onFinish={() => {}} />
    </ProjectData>,
  );
  return screen.findByRole("textbox", { name: "消息" }) as Promise<HTMLTextAreaElement>;
}

test("ArrowUp recalls previously sent messages and ArrowDown restores the draft", async () => {
  const input = await renderChat();
  // Newest first, then one step further back.
  fireEvent.keyDown(input, { key: "ArrowUp" });
  await waitFor(() => assert.equal(input.value, "第二轮问题"));
  fireEvent.keyDown(input, { key: "ArrowUp" });
  await waitFor(() => assert.equal(input.value, "第一轮问题"));
  // Back toward the newest, and then the draft that was being typed.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => assert.equal(input.value, "第二轮问题"));
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => assert.equal(input.value, ""));
});

test("recall stays out of the way while a draft is being written", async () => {
  const input = await renderChat();
  fireEvent.change(input, { target: { value: "还没写完的草稿" } });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  // The handler only recalls an empty draft, so the caret keeps its native
  // behaviour and the text is untouched.
  assert.equal(input.value, "还没写完的草稿");
});

test("voice actions are fully removed from the composer and message bar", async () => {
  const input = await renderChat();
  assert.equal(screen.queryByRole("button", { name: "朗读这条回复" }), null);
  assert.equal(screen.queryByRole("button", { name: "语音输入" }), null);
  assert.ok(input);
});

test("a streamed reply reports observed latency but never an estimated token rate", async () => {
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/chat")) {
      return new Response(
        `${[
          { type: "start", messageId: "answer" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "已收到" },
          { type: "text-end", id: "text" },
          { type: "finish" },
        ]
          .map((v) => `data: ${JSON.stringify(v)}\n\n`)
          .join("")}data: [DONE]\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "x-vercel-ai-ui-message-stream": "v1",
            "x-platform-run-id": "run",
          },
        },
      );
    }
    throw new Error(`Unexpected ${url}`);
  };
  render(
    <ProjectData projectId="project">
      <Chat projectId="project" conversationId="stream" messages={[]} onFinish={() => {}} />
    </ProjectData>,
  );
  const input = await screen.findByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "在吗" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByText("已收到");
  // `tokensPerSecond` from the library is `textLength / 4` on this runtime, not
  // usage from the stream, so showing it would publish an estimate as a
  // measurement. Only the client-observed durations are allowed on screen.
  await waitFor(() => assert.equal(/tok\/s/.test(document.body.textContent ?? ""), false));
  assert.equal(/tok\/s/.test(document.body.textContent ?? ""), false);
});
