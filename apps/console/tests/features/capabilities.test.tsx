import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AssistantCapabilities, ProjectAccess, Tool } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { PlatformAssistant } from "../../src/features/assistant/index.ts";
import { SystemCapabilityDirectory } from "../../src/features/capabilities/index.ts";
import { SkillWorkspace } from "../../src/features/skills/index.ts";
import { ToolWorkspace } from "../../src/features/tools/index.ts";
import { ProjectAccessContext, pagePermission } from "../../src/shared/access.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";
import { Selection } from "../helpers/selection.tsx";

afterEach(cleanup);
const viewer: ProjectAccess = {
  projectId: "project",
  role: "viewer",
  tenantRole: "member",
  permissions: ["project.read", "resource.read"],
};
const usage = { count: 0, lastUsedAt: null };
const catalog: AssistantCapabilities = {
  version: 1,
  conversationId: null,
  permissions: viewer.permissions,
  skills: [
    {
      id: "agent-builder",
      name: "创建业务智能体",
      description: "组合模型和指导",
      instructions: "只使用真实资源 ID，按最小工具权限绑定。",
      version: 1,
      digest: "a".repeat(64),
      source: "system",
      readOnly: true,
      bindable: false,
      usage,
    },
  ],
  tools: [
    {
      id: "platform_read",
      name: "查询与预览资源",
      description: "按权限查询",
      summary: "读取项目资源与状态",
      version: 1,
      digest: "b".repeat(64),
      source: "system",
      readOnly: true,
      bindable: false,
      inputSchema: { type: "object" },
      available: true,
      unavailableReason: null,
      usage,
    },
  ],
  operations: [
    {
      id: "agent.list",
      label: "查看智能体",
      group: "agent",
      mode: "read",
      risk: "draft",
      permission: "resource.read",
      tenantAdmin: false,
      available: true,
      unavailableReason: null,
    },
    {
      id: "agent.create",
      label: "创建智能体草稿",
      group: "agent",
      mode: "write",
      risk: "draft",
      permission: "agent.edit",
      tenantAdmin: false,
      available: false,
      unavailableReason: "需要编辑智能体权限",
    },
  ],
};
function mount(child: ReactNode, access = viewer) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="project" owner="viewer">
          <ProjectAccessContext.Provider value={access}>{child}</ProjectAccessContext.Provider>
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
}

test("viewer can inspect Skills and tool schemas without importing, editing or executing", async (t) => {
  assert.equal(pagePermission("tools"), "resource.read");
  assert.equal(pagePermission("skills"), "resource.read");
  const requests: Request[] = [];
  const tool: Tool = {
    id: "tool",
    projectId: "project",
    name: "example_sum",
    description: "合成示例",
    kind: "sum",
    url: "",
    inputSchema: { type: "object", properties: { values: { type: "array" } } },
    outputSchema: { type: "number" },
    version: 1,
    hasCredential: false,
    createdAt: "2026-09-14",
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    return Response.json(req.url.endsWith("/tools") ? [tool] : []);
  });
  mount(
    <ToolWorkspace onCreate={() => assert.fail("create")} onEdit={() => assert.fail("edit")} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /查\s*看/ }));
  await screen.findByText(/当前角色只能查看定义/);
  assert.ok(screen.getByText(/"values"/));
  assert.equal(screen.queryByRole("button", { name: /编\s*辑/ }), null);
  cleanup();
  mount(<Selection>{(s) => <SkillWorkspace {...s} />}</Selection>);
  await screen.findByText("将团队经验变成可复用的 Skills");
  assert.equal(
    (screen.getByRole("button", { name: "导入 Skill" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole("button", { name: "导入第一个 Skill" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.ok(requests.every((r) => r.method === "GET"));
});

test("system directory filters operations and loads parameter schemas only on expansion", async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requested.push(req.url);
    return Response.json(
      req.url.includes("/operations/")
        ? {
            ...catalog.operations[0],
            inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
          }
        : catalog,
    );
  });
  mount(<SystemCapabilityDirectory kind="tools" />);
  await screen.findByText("创建智能体草稿");
  assert.equal(requested.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "仅看可用" }));
  assert.equal(screen.queryByText("创建智能体草稿"), null);
  const summary = screen.getByText("查看智能体").closest("summary");
  assert.ok(summary);
  fireEvent.click(summary);
  await screen.findByText(/"cursor"/);
  assert.equal(requested.filter((url) => url.includes("/operations/")).length, 1);
  fireEvent.change(screen.getByRole("textbox", { name: "搜索系统操作" }), {
    target: { value: "无匹配" },
  });
  await screen.findByText("没有匹配的操作");
});

test("taskdesk exposes read-only capability instructions before configuring a model, without starting a task", async (t) => {
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    methods.push(req.method);
    return Response.json(
      req.url.endsWith("/capabilities")
        ? catalog
        : { configuration: null, canConfigure: false, skills: [], operations: [], sessions: [] },
    );
  });
  mount(
    <PlatformAssistant
      projectId="project"
      projectName="测试"
      user={{
        id: "viewer",
        tenantId: "tenant",
        kind: "user",
        entry: "console",
        displayName: "Viewer",
      }}
      context={{ page: "skills" }}
      onNavigate={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  fireEvent.click(await screen.findByRole("button", { name: "我的能力" }));
  fireEvent.click(await screen.findByRole("button", { name: /创建业务智能体/ }));
  await screen.findByText("只使用真实资源 ID，按最小工具权限绑定。");
  assert.ok(screen.getByText("平台助手专用 · 不可直接绑定业务 Agent"));
  assert.ok(methods.every((m) => m === "GET"));
});

test("capability failures are retryable and opening the system tab preserves project resources", async (t) => {
  let fail = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/capabilities"))
      return fail
        ? Response.json({ message: "能力服务暂时不可用" }, { status: 503 })
        : Response.json(catalog);
    return Response.json([]);
  });
  mount(<Selection>{(s) => <SkillWorkspace {...s} />}</Selection>);
  fireEvent.click(screen.getByRole("tab", { name: "系统内置" }));
  await screen.findByText("能力服务暂时不可用");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试系统能力" }));
  await screen.findByRole("button", { name: /创建业务智能体/ });
  fireEvent.click(screen.getByRole("tab", { name: "项目自定义" }));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: /创建业务智能体/ }), null));
  assert.ok(await screen.findByText("将团队经验变成可复用的 Skills"));
});
