import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { mountConsole } from "../helpers/console.tsx";

afterEach(cleanup);
const user = {
  id: "owner",
  tenantId: "tenant",
  displayName: "Owner",
  kind: "user",
  entry: "console",
};
const projects = [
  {
    id: "A",
    tenantId: "tenant",
    name: "项目A",
    description: "",
    createdAt: "2026-09-08T00:00:00Z",
  },
];
const published = {
  id: "agent-A",
  projectId: "A",
  name: "订单助手",
  description: "查询与汇总订单",
  modelId: "model",
  toolIds: [],
  publishedVersion: 2,
  publishedReleaseId: "release-A",
  draftRevision: 1,
};
const draftOnly = {
  ...published,
  id: "agent-B",
  name: "未发布助手",
  description: "",
  publishedVersion: null,
  publishedReleaseId: null,
};
const conversation = {
  id: "conversation-new",
  projectId: "A",
  agentId: "agent-A",
  releaseId: "release-A",
  releaseVersion: 2,
  title: "新会话",
  createdAt: "2026-09-11T00:00:00Z",
};
function shell(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/access"))
    return Response.json({
      projectId: "A",
      role: "admin",
      tenantRole: "owner",
      permissions: [
        "project.read",
        "project.manage",
        "agent.edit",
        "agent.publish",
        "agent.run",
        "resource.read",
        "resource.edit",
        "resource.manage",
      ],
    });
  if (path.endsWith("/auth/status")) return Response.json({ initialized: true });
  if (path === "/api/v1/me") return Response.json(user);
  if (path === "/api/v1/projects") return Response.json(projects);
  return null;
}
test("the chat page picks a published agent in place instead of leaving the page", async (t) => {
  let created: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname,
      shelled = shell(request);
    if (shelled) return shelled;
    if (path === "/api/v1/projects/A/agents") return Response.json([published, draftOnly]);
    if (request.method === "POST" && path === "/api/v1/projects/A/conversations") {
      created = await request.json();
      return Response.json(conversation);
    }
    return Response.json([]);
  });
  const { router } = mountConsole({ initialEntries: ["/projects/A/chat"] });
  await screen.findByText("选择一个 Agent 开始对话");
  fireEvent.click(screen.getByRole("button", { name: "选择 Agent" }));
  await screen.findByText("订单助手");
  // A draft-only Agent cannot host a conversation, so it is never offered.
  assert.equal(screen.queryByText("未发布助手"), null);
  assert.ok(screen.getByText(/已发布 v2/));
  fireEvent.click(screen.getByRole("button", { name: /订单助手/ }));
  await waitFor(() => assert.equal(created?.agentId, "agent-A"));
  await waitFor(() =>
    assert.ok(
      router.state.location.pathname.endsWith("/chat/conversation-new"),
      router.state.location.pathname,
    ),
  );
});
test("an empty catalogue explains the missing step instead of navigating away silently", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname,
      shelled = shell(request);
    if (shelled) return shelled;
    if (path === "/api/v1/projects/A/agents") return Response.json([draftOnly]);
    return Response.json([]);
  });
  const { router } = mountConsole({ initialEntries: ["/projects/A/chat"] });
  await screen.findByText("选择一个 Agent 开始对话");
  fireEvent.click(screen.getByRole("button", { name: "选择 Agent" }));
  await screen.findByText("还没有已发布的 Agent");
  // The page the user was reading is kept; going to Agents is their explicit choice.
  assert.equal(router.state.location.pathname, "/projects/A/chat");
  fireEvent.click(screen.getByRole("button", { name: "前往 Agents" }));
  await waitFor(() =>
    assert.ok(router.state.location.pathname.endsWith("/agents"), router.state.location.pathname),
  );
});

test("conversation navigation collapses without remounting the live composer or losing its draft", async (t) => {
  let historyReads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname,
      shelled = shell(request);
    if (shelled) return shelled;
    if (path.endsWith("/conversations"))
      return Response.json({ items: [conversation], nextCursor: null });
    if (path.endsWith("/conversations/conversation-new")) return Response.json(conversation);
    if (path.endsWith("/session")) {
      historyReads++;
      return Response.json({ messages: [], resumeRun: null });
    }
    if (path.endsWith("/capabilities")) return Response.json({ skills: [] });
    return Response.json([]);
  });
  const { router } = mountConsole({ initialEntries: ["/projects/A/chat/conversation-new"] });
  const input = (await screen.findByRole("textbox", { name: "消息" })) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "尚未发送的草稿" } });
  assert.equal(screen.queryByRole("complementary", { name: "会话列表" }), null);
  assert.ok(screen.getByRole("button", { name: "新建会话" }));
  fireEvent.click(screen.getByRole("button", { name: "展开会话列表" }));
  assert.ok(await screen.findByRole("complementary", { name: "会话列表" }));
  fireEvent.click(screen.getByRole("button", { name: "收起会话列表" }));
  assert.equal(screen.queryByRole("complementary", { name: "会话列表" }), null);
  assert.equal(screen.getByRole("textbox", { name: "消息" }), input);
  assert.equal(input.value, "尚未发送的草稿");
  assert.equal(historyReads, 1);
  assert.equal(router.state.location.pathname, "/projects/A/chat/conversation-new");
});
