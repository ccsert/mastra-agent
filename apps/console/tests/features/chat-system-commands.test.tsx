import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { parseChatCommand } from "../../src/features/chat/commands.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
test("reserved commands require the whole message, keep prose and paths intact", () => {
  assert.deepEqual(parseChatCommand(" /new "), { name: "clear", argument: "" });
  assert.deepEqual(parseChatCommand("/compact 保留角色规则"), {
    name: "compact",
    argument: "保留角色规则",
  });
  for (const text of [
    "解释 /clear",
    "```\n/clear\n```",
    "/clear/file",
    "/skill clear",
    "https://host/compact",
  ])
    assert.equal(parseChatCommand(text), null);
});

test("click and form submission execute local commands without sending a model request", async () => {
  let resets = 0,
    selected = "";
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/context"))
      return Response.json({
        totalMessages: 4,
        coveredMessages: 2,
        summary: "合成上下文摘要",
        runId: "run",
        createdAt: "2026-09-14T00:00:00Z",
      });
    if (url.endsWith("/reset")) {
      resets++;
      return Response.json({
        id: "new-session",
        agentId: "a",
        projectId: "project",
        releaseId: "r",
        releaseVersion: 1,
        title: "新会话",
        createdAt: "2026-09-14T00:00:00Z",
      });
    }
    throw new Error(`Unexpected model request: ${url}`);
  };
  render(
    <ProjectData projectId="project">
      <Chat
        projectId="project"
        conversationId="commands"
        messages={[]}
        onFinish={() => {}}
        onReset={(next) => {
          selected = next.id;
        }}
      />
    </ProjectData>,
  );
  const input = screen.getByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "/help" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByText("对话指令");
  assert.equal(resets, 0);
  fireEvent.click(screen.getByRole("button", { name: /Close/ }));
  fireEvent.change(input, { target: { value: "/context" } });
  fireEvent.keyDown(input, { key: "Escape" });
  const form = input.closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  await screen.findByText("合成上下文摘要");
  fireEvent.click(screen.getByRole("button", { name: /Close/ }));
  fireEvent.change(input, { target: { value: "/clear" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(selected, "new-session"));
  assert.equal(resets, 1);
});
