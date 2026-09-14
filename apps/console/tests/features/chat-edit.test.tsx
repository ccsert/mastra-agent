import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);

test("native message editor cancels without changing history and branches on send", async () => {
  const requests: unknown[] = [];
  let branch = "";
  globalThis.fetch = async (url, init) => {
    const path = url instanceof Request ? url.url : String(url);
    if (path.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (path.endsWith("/edit")) {
      requests.push(url instanceof Request ? await url.json() : JSON.parse(String(init?.body)));
      return Response.json({ id: "branched" });
    }
    throw new Error(`Unexpected ${url}`);
  };
  render(
    <ProjectData projectId="project">
      <Chat
        projectId="project"
        conversationId="edit-native"
        messages={[{ id: "u1", role: "user", parts: [{ type: "text", text: "原始问题" }] }]}
        onFinish={() => {}}
        onFork={(id) => {
          branch = id;
        }}
      />
    </ProjectData>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "编辑并派生新分支" }));
  const editor = (await screen.findByRole("textbox", { name: "编辑消息" })) as HTMLTextAreaElement;
  assert.equal(editor.value, "原始问题");
  fireEvent.change(editor, { target: { value: "撤销内容" } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await screen.findByText("原始问题");
  assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "编辑并派生新分支" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "编辑消息" }), {
    target: { value: "修改后的问题" },
  });
  fireEvent.click(screen.getByRole("button", { name: "派生并发送" }));
  await waitFor(() => assert.equal(branch, "branched"));
  assert.equal(requests.length, 1);
  assert.deepEqual(
    { ...(requests[0] as object), requestId: "ignored" },
    { input: "修改后的问题", messageId: "u1", requestId: "ignored" },
  );
});
