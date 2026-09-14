import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";
import { clearChatSession } from "../../src/shared/data/session-storage.ts";

afterEach(() => {
  cleanup();
  clearChatSession();
});
const userMessage: UIMessage = {
  id: "saved-user",
  role: "user",
  parts: [{ type: "text", text: "继续计算" }],
};
function session(owner = "tenant:owner", resumeRun: { id: string; status: string } | null = null) {
  return (
    <ProjectData projectId="project" owner={owner}>
      <Chat
        projectId="project"
        conversationId="conversation"
        messages={resumeRun ? [userMessage] : []}
        resumeRun={resumeRun}
        onFinish={() => {}}
      />
    </ProjectData>
  );
}
const encode = (chunk: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
function response(body: BodyInit) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-platform-run-id": "existing",
      "x-resumable-stream-id": "existing",
    },
  });
}

test("draft and pinned Skill survive a complete authenticated workspace remount and remain account scoped", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      skills: [{ versionId: "pinned", name: "report", version: 2, description: "", enabled: true }],
    }),
  );
  const first = render(session());
  const input = await screen.findByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "/report" } });
  await screen.findByRole("option", { name: /report/ });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "刷新以后继续写" } });
  first.unmount();
  const second = render(session());
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
      "刷新以后继续写",
    ),
  );
  await screen.findByRole("region", { name: "本次指定的 Skills" });
  second.unmount();
  render(session("tenant:other"));
  await waitFor(() =>
    assert.equal((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value, ""),
  );
  assert.equal(screen.queryByRole("region", { name: "本次指定的 Skills" }), null);
});

test("opening an active run resumes by GET, restores exactly one answer and can cancel the original run", async (t) => {
  let readerCancelled = false;
  let posts = 0,
    gets = 0,
    cancels = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.includes("/stream?")) {
      gets++;
      assert.equal(init?.method, "GET");
      return response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode({ type: "start", messageId: "assistant-existing" }));
            controller.enqueue(encode({ type: "text-start", id: "text" }));
            controller.enqueue(encode({ type: "text-delta", id: "text", delta: "已经恢复的内容" }));
          },
          cancel() {
            readerCancelled = true;
          },
        }),
      );
    }
    if (url.endsWith("/cancel")) {
      cancels++;
      return Response.json({ id: "existing", status: "cancelled" });
    }
    posts++;
    throw new Error(`Unexpected POST: ${url}`);
  });
  render(session("tenant:owner", { id: "existing", status: "running" }));
  await screen.findByText("已经恢复的内容");
  assert.equal(screen.getAllByText("继续计算").length, 1);
  fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
  await waitFor(() => assert.equal(cancels, 1));
  await waitFor(() => assert.equal(readerCancelled, true));
  await screen.findByRole("button", { name: "发送消息" });
  assert.equal(posts, 0);
  assert.equal(gets, 1);
});

test("a disconnected stream reconciles with saved history and retries the same run without another POST", async (t) => {
  let posts = 0,
    reconnects = 0;
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/workspace"))
      return Response.json({ skills: [], artifacts: [], subagents: [] });
    if (url.endsWith("/chat")) {
      posts++;
      return response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode({ type: "start", messageId: "assistant-existing" }));
            controller.enqueue(encode({ type: "text-start", id: "text" }));
            controller.enqueue(encode({ type: "text-delta", id: "text", delta: "中断前" }));
            setTimeout(() => controller.error(new TypeError("network lost")), 30);
          },
        }),
      );
    }
    if (url.endsWith("/session"))
      return Response.json({
        messages: [userMessage],
        resumeRun: { id: "existing", status: "running" },
      });
    if (url.includes("/stream?")) {
      reconnects++;
      assert.equal(init?.method, "GET");
      return response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "start", messageId: "assistant-existing" },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "恢复后的完整回复" },
              { type: "text-end", id: "text" },
              { type: "finish", finishReason: "stop" },
            ])
              controller.enqueue(encode(chunk));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      );
    }
    throw new Error(`Unexpected ${url}`);
  });
  render(session());
  fireEvent.change(await screen.findByRole("textbox", { name: "消息" }), {
    target: { value: "继续计算" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByRole("button", { name: "重新连接" });
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await screen.findByText("恢复后的完整回复");
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "重新连接" }), null));
  assert.equal(screen.getAllByText("继续计算").length, 1);
  assert.equal(screen.getAllByText("恢复后的完整回复").length, 1);
  assert.equal(posts, 1);
  assert.equal(reconnects, 1);
});

test("a POST accepted without response headers discovers its run and opens exactly one native recovery reader", async (t) => {
  let posts = 0,
    reconnects = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/workspace"))
      return Response.json({ skills: [], artifacts: [], subagents: [] });
    if (url.endsWith("/chat")) {
      posts++;
      throw new TypeError("accepted but response headers lost");
    }
    if (url.endsWith("/session"))
      return Response.json({
        messages: [userMessage],
        resumeRun: { id: "existing", status: "running" },
      });
    if (url.includes("/stream?")) {
      reconnects++;
      // Leave enough time for the native storage observer to run before GET's
      // headers arrive; this catches two independently initiated resume readers.
      await new Promise((resolve) => setTimeout(resolve, 80));
      return response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "start", messageId: "assistant-existing" },
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "响应头丢失后已恢复" },
              { type: "text-end", id: "text" },
              { type: "finish", finishReason: "stop" },
            ])
              controller.enqueue(encode(chunk));
            controller.close();
          },
        }),
      );
    }
    throw new Error(`Unexpected ${url}`);
  });
  render(session());
  fireEvent.change(await screen.findByRole("textbox", { name: "消息" }), {
    target: { value: "继续计算" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新连接" }));
  await screen.findByText("响应头丢失后已恢复");
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "重新连接" }), null));
  assert.equal(screen.getAllByText("继续计算").length, 1);
  assert.equal(reconnects, 1);
  assert.equal(posts, 1);
});
