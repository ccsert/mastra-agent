import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);

const skills = [
  { versionId: "pinned", name: "report", version: 1, description: "生成报表", enabled: true },
];
function session(conversationId: string, projectId = "project", owner = "session") {
  return (
    <ProjectData key={owner} projectId={projectId}>
      <Chat
        key={`${projectId}:${conversationId}`}
        projectId={projectId}
        conversationId={conversationId}
        messages={[]}
        onFinish={() => {}}
      />
    </ProjectData>
  );
}

test("switching conversations preserves each draft and pinned Skill without sending", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills }));
  const view = render(session("a"));
  const input = (await screen.findByRole("textbox", { name: "消息" })) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "/report" } });
  await screen.findByRole("option", { name: /report/ });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "还没写完的报表问题" } });
  view.rerender(session("b"));
  const other = (await screen.findByRole("textbox", { name: "消息" })) as HTMLTextAreaElement;
  assert.equal(other.value, "");
  assert.equal(screen.queryByRole("region", { name: "本次指定的 Skills" }), null);
  fireEvent.change(other, { target: { value: "另一会话的草稿" } });
  view.rerender(session("a"));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
      "还没写完的报表问题",
    ),
  );
  await screen.findByRole("region", { name: "本次指定的 Skills" });
  view.rerender(session("b"));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
      "另一会话的草稿",
    ),
  );
});

test("drafts do not cross projects or authenticated workspace lifetimes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills: [] }));
  const view = render(session("same-id", "a"));
  fireEvent.change(await screen.findByRole("textbox", { name: "消息" }), {
    target: { value: "项目 A 草稿" },
  });
  view.rerender(session("same-id", "b"));
  assert.equal(
    ((await screen.findByRole("textbox", { name: "消息" })) as HTMLTextAreaElement).value,
    "",
  );
  view.rerender(session("same-id", "a", "new-login"));
  assert.equal(
    ((await screen.findByRole("textbox", { name: "消息" })) as HTMLTextAreaElement).value,
    "",
  );
});

test("cancel before response headers waits for the server Run then aborts the reader", async (t) => {
  let resolveHeaders: (response: Response) => void = () => {
    throw new Error("Response resolver was not initialized");
  };
  const headers = new Promise<Response>((resolve) => {
    resolveHeaders = resolve;
  });
  let signal: AbortSignal | null | undefined;
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/chat")) {
      signal = init?.signal;
      return headers;
    }
    if (url.endsWith("/runs/run/cancel")) {
      cancelled++;
      assert.equal(signal?.aborted, false, "the request must survive until its Run is cancelled");
      return Response.json({ id: "run", status: "cancelled" });
    }
    throw new Error(`Unexpected ${url}`);
  });
  render(session("cancel"));
  fireEvent.change(await screen.findByRole("textbox", { name: "消息" }), {
    target: { value: "开始任务" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.ok(signal));
  fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
  await screen.findByRole("button", { name: "正在停止" });
  assert.equal(signal?.aborted, false);
  assert.equal(cancelled, 0);
  await act(async () =>
    resolveHeaders(
      new Response("data: [DONE]\n\n", {
        headers: {
          "Content-Type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "x-platform-run-id": "run",
        },
      }),
    ),
  );
  await waitFor(() => assert.equal(cancelled, 1));
  await waitFor(() => assert.equal(signal?.aborted, true));
  await screen.findByRole("button", { name: "发送消息" });
  assert.equal(screen.queryByRole("alert"), null);
});

test("code blocks copy just their code and markdown keeps the existing image policy", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ skills: [] }));
  let copied = "";
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  });
  render(
    <ProjectData projectId="project">
      <Chat
        projectId="project"
        conversationId="code"
        onFinish={() => {}}
        messages={[
          {
            id: "answer",
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "```ts\nconst answer = 42;\n```\n\n![外部图片](https://example.com/pixel.png)\n\n[文档](https://example.com/docs)",
              },
            ],
          },
        ]}
      />
    </ProjectData>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "复制代码" }));
  await waitFor(() => assert.equal(copied, "const answer = 42;\n"));
  await screen.findByRole("button", { name: "已复制代码" });
  assert.equal(document.querySelector("img"), null);
  const link = screen.getByRole("link", { name: "文档" });
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer");
});
