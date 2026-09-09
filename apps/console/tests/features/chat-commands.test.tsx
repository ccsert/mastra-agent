import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat } from "../../src/features/chat/Chat.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
test("slash selection uses pinned Skill IDs in the stream request and clears after acceptance", async () => {
  let body: { skillVersionIds: string[] } | undefined;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/capabilities"))
      return Response.json({
        skills: [
          {
            versionId: "pinned",
            name: "report-skill",
            version: 2,
            description: "生成报表",
            enabled: true,
          },
          {
            versionId: "revoked",
            name: "old-skill",
            version: 1,
            description: "旧版",
            enabled: false,
          },
        ],
      });
    if (url.endsWith("/chat")) {
      body = JSON.parse(String(init?.body));
      return new Response(
        `${[
          { type: "start", messageId: "answer" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "完成报表" },
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
      <Chat projectId="project" conversationId="conversation" messages={[]} onFinish={() => {}} />
    </ProjectData>,
  );
  const input = screen.getByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "/" } });
  const option = await screen.findByRole("option", { name: /report-skill/ });
  assert.equal(
    screen.getByRole("option", { name: /old-skill/ }).getAttribute("aria-disabled"),
    "true",
  );
  assert.ok(option);
  fireEvent.change(input, { target: { value: "/skill report" } });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(body, undefined);
  assert.ok(screen.getByRole("region", { name: "本次指定的 Skills" }));
  assert.equal((input as HTMLTextAreaElement).value, "");
  fireEvent.change(input, { target: { value: "生成订单报表" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.deepEqual(body?.skillVersionIds, ["pinned"]));
  await screen.findByText("完成报表");
  assert.equal(screen.queryByRole("region", { name: "本次指定的 Skills" }), null);
});
