import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Agent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { AgentEditor } from "../../src/features/agents/AgentEditor.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";
import { mountConsole } from "../helpers/console.tsx";

afterEach(cleanup);
const agent: Agent = {
  id: "agent",
  projectId: "A",
  name: "草稿",
  description: "",
  instructions: "简短回答",
  modelId: "model",
  toolIds: [],
  knowledgeBaseIds: [],
  skillBindings: [],
  maxSteps: 5,
  draftRevision: 1,
  publishedReleaseId: null,
  publishedVersion: null,
  createdAt: "2026-09-13",
};
function catalog(path: string) {
  return Response.json(
    path.endsWith("/models")
      ? [{ id: "model", kind: "chat", name: "测试模型", modelId: "test" }]
      : path.endsWith("/agents")
        ? [agent]
        : [],
  );
}
function editor(
  onCreated?: (a: Agent) => void,
  initial: Agent | undefined = agent,
  canPublish = true,
) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="A">
          <AgentEditor
            projectId="A"
            agent={initial}
            onCreated={onCreated}
            onClose={() => {}}
            onSaved={() => {}}
            canPublish={canPublish}
          />
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
}
test("saved drafts survive a failed preview and retain fields from hidden sections", async (t) => {
  let body: Record<string, unknown> | undefined,
    previewBody: Record<string, unknown> | undefined,
    created: Agent | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    if (req.method === "POST" && path.endsWith("/agents")) {
      body = await req.json();
      return Response.json(agent);
    }
    if (req.method === "POST" && path.endsWith("/preview")) {
      previewBody = await req.json();
      return Response.json({ message: "试用依赖暂不可用" }, { status: 503 });
    }
    return catalog(path);
  });
  // Pass a fresh editor explicitly; the separate helper default represents an existing draft.
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="A">
          <AgentEditor
            projectId="A"
            onCreated={(a) => {
              created = a;
            }}
            onClose={() => {}}
            onSaved={() => {}}
          />
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
  await waitFor(() =>
    assert.ok(!screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")),
  );
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新草稿" } });
  fireEvent.change(screen.getByLabelText("角色与指令"), { target: { value: "保留用途指令" } });
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "模型服务" }));
  fireEvent.click(
    await screen.findByText("测试模型 · test", { selector: ".ant-select-item-option-content" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /运行设置/ }));
  fireEvent.click(screen.getByRole("button", { name: /复杂任务/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存并试用" }));
  await screen.findByText("试用依赖暂不可用");
  await waitFor(() => assert.equal(created?.id, agent.id));
  assert.equal(body?.instructions, "保留用途指令");
  assert.equal(body?.maxSteps, 80);
  assert.equal(body?.planningEnabled, true);
  assert.equal(previewBody?.baseRevision, 1);
  assert.match(String(previewBody?.requestId), /^[\da-f-]{36}$/);
  assert.ok(screen.getByText("草稿 r1 · 已保存"));
});
test("editors save drafts while formal publishing remains unavailable", async (t) => {
  const writes: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    if (req.method !== "GET") {
      writes.push(path);
      return Response.json({ ...agent, draftRevision: 2 });
    }
    return catalog(path);
  });
  editor(undefined, agent, false);
  await waitFor(() =>
    assert.ok(!screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")),
  );
  assert.ok(screen.getByRole("button", { name: "需管理员发布" }).hasAttribute("disabled"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "编辑者修改" } });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿 r2 · 已保存");
  assert.deepEqual(writes, ["/api/v1/projects/A/agents/agent"]);
});
test("permission outages expose retry; member navigation never loads management resources", async (t) => {
  let unavailable = true;
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    paths.push(path);
    if (path.endsWith("/auth/status")) return Response.json({ initialized: true });
    if (path.endsWith("/me"))
      return Response.json({
        id: "member",
        tenantId: "t",
        kind: "user",
        entry: "console",
        displayName: "成员",
        tenantRole: "member",
      });
    if (path === "/api/v1/projects") return Response.json([{ id: "A", name: "A", tenantId: "t" }]);
    if (path.endsWith("/access"))
      return unavailable
        ? Response.json({ message: "权限服务暂不可用" }, { status: 503 })
        : Response.json({
            projectId: "A",
            role: "member",
            tenantRole: "member",
            permissions: ["project.read", "agent.run"],
          });
    return catalog(path);
  });
  mountConsole({ initialEntries: ["/projects/A/agents"] });
  await screen.findByText("项目权限加载失败");
  assert.equal(screen.queryByRole("button", { name: "创建 Agent" }), null);
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "重试项目权限" }));
  await screen.findByRole("heading", { name: "草稿" });
  assert.equal(screen.queryByRole("link", { name: "项目设置" }), null);
  assert.equal(screen.queryByRole("button", { name: "配置 Agent" }), null);
  assert.ok(!paths.some((path) => /\/(models|tools|skills|applications)$/.test(path)));
});
