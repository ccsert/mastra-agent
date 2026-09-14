import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AssistantProposal } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { PlatformAssistant } from "../../src/features/assistant/PlatformAssistant.tsx";
import { ProposalCard } from "../../src/features/assistant/ProposalCard.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";
import { clearChatSession } from "../../src/shared/data/session-storage.ts";
import { mockInsecureContext } from "../helpers/insecure-context.ts";

afterEach(() => {
  cleanup();
  clearChatSession();
});
const base: AssistantProposal = {
  id: "proposal",
  conversationId: "session",
  title: "创建合成助手",
  reason: "仅用于验收",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  actions: [
    {
      key: "draft",
      operation: "agent.create",
      input: { name: "合成助手", instructions: "只使用用户给出的事实" },
      label: "创建 Agent 草稿",
      risk: "draft",
      status: "pending",
      result: null,
      error: null,
    },
  ],
};
test("review exposes exact configuration and prevents expired, running or completed actions from being applied", async () => {
  let applies = 0;
  const view = render(
    <ProposalCard
      proposal={base}
      busy={false}
      onApply={() => applies++}
      onAdjust={() => {}}
      onNavigate={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("检查完整配置"));
  assert.match(screen.getByText(/只使用用户给出的事实/).textContent ?? "", /只使用用户给出的事实/);
  fireEvent.click(screen.getByRole("button", { name: "应用 1 项更改" }));
  assert.equal(applies, 1);
  view.rerender(
    <ProposalCard
      proposal={{ ...base, expiresAt: new Date(0).toISOString() }}
      busy={false}
      onApply={() => applies++}
      onAdjust={() => {}}
      onNavigate={() => {}}
    />,
  );
  assert.equal(
    (screen.getByRole("button", { name: "预览已过期" }) as HTMLButtonElement).disabled,
    true,
  );
  view.rerender(
    <ProposalCard
      proposal={{ ...base, status: "applying" }}
      busy
      onApply={() => applies++}
      onAdjust={() => {}}
      onNavigate={() => {}}
    />,
  );
  assert.equal(screen.queryByRole("button", { name: /应用/ }), null);
});
test("partial failure keeps successful results and shows uncertain outcome without offering replay", async () => {
  let target = "";
  render(
    <ProposalCard
      proposal={{
        ...base,
        status: "failed",
        actions: [
          {
            ...base.actions[0],
            status: "succeeded",
            result: { id: "created", resourceId: "created", page: "agents" },
          },
          {
            ...base.actions[0],
            key: "unknown",
            status: "unknown",
            error: "执行结果未能确认，请先检查资源",
          },
        ],
      }}
      busy={false}
      onApply={() => {
        throw new Error("must not replay");
      }}
      onAdjust={() => {}}
      onNavigate={(_page, id) => {
        target = id ?? "";
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /查看结果/ }));
  assert.equal(target, "created");
  assert.ok(screen.getByText(/已成功的步骤保留/));
  assert.equal(screen.queryByRole("button", { name: /应用/ }), null);
});
test("global shortcut opens the chat directly without a model call and minimizing preserves its draft", async (t) => {
  const starts: Record<string, unknown>[] = [];
  let chatPosts = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input),
      method = input instanceof Request ? input.method : init?.method;
    if (url.endsWith("/assistant"))
      return Response.json({
        configuration: { modelId: "model", modelName: "Fixture" },
        canConfigure: true,
        operations: [],
        skills: [],
        sessions: [],
      });
    if (url.endsWith("/assistant/sessions") && method === "POST") {
      starts.push(
        input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)),
      );
      return Response.json({
        id: "assistant-session",
        title: "新会话",
        context: { page: "agents" },
        createdAt: new Date().toISOString(),
      });
    }
    if (url.endsWith("/session"))
      return Response.json({
        messages: [],
        resumeRun: null,
      });
    if (url.endsWith("/proposals")) return Response.json([]);
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    if (url.endsWith("/chat")) chatPosts++;
    return Response.json([]);
  });
  render(
    <ProjectData projectId="project" owner="owner">
      <PlatformAssistant
        projectId="project"
        projectName="Test"
        user={{
          id: "owner",
          tenantId: "tenant",
          entry: "console",
          displayName: "Owner",
          kind: "user",
        }}
        context={{ page: "agents" }}
        onNavigate={() => {}}
      />
    </ProjectData>,
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
  const composer = await screen.findByRole("textbox", { name: "消息" });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].message, undefined);
  assert.equal(screen.queryByRole("textbox", { name: "平台助手任务目标" }), null);
  assert.equal(chatPosts, 0);
  fireEvent.change(composer, { target: { value: "尚未发送的补充" } });
  fireEvent.click(screen.getByRole("button", { name: /变更清单/ }));
  assert.equal(screen.queryByRole("textbox", { name: "消息" }), null);
  fireEvent.click(screen.getByRole("button", { name: /返回对话/ }));
  assert.equal(
    (screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
    "尚未发送的补充",
  );
  fireEvent.click(screen.getByRole("button", { name: "收起平台助手" }));
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
      "尚未发送的补充",
    ),
  );
  assert.equal(starts.length, 1);
});

test("HTTP LAN assistant creates an empty task and opens chat without crypto.randomUUID", async (t) => {
  mockInsecureContext(t);
  const requests: { requestId: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/assistant"))
      return Response.json({
        configuration: { modelId: "model", modelName: "Fixture" },
        canConfigure: false,
        operations: [],
        skills: [],
        sessions: [],
      });
    if (url.endsWith("/assistant/sessions")) {
      requests.push(
        input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)),
      );
      return Response.json({
        id: `empty-task-${requests.length}`,
        title: "新会话",
        context: { page: "agents" },
        createdAt: new Date().toISOString(),
      });
    }
    if (url.endsWith("/session")) return Response.json({ messages: [], resumeRun: null });
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    return Response.json([]);
  });
  render(
    <ProjectData projectId="project" owner="empty-owner">
      <PlatformAssistant
        projectId="project"
        projectName="Test"
        user={{
          id: "owner",
          tenantId: "tenant",
          entry: "console",
          displayName: "Owner",
          kind: "user",
        }}
        context={{ page: "agents" }}
        onNavigate={() => {}}
      />
    </ProjectData>,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  const composer = await screen.findByRole("textbox", { name: "消息" });
  assert.equal(requests.length, 1);
  assert.ok(screen.getByText("一起把目标变成可用的能力"));
  fireEvent.change(composer, { target: { value: "旧会话内容" } });
  fireEvent.click(screen.getByRole("button", { name: /变更清单/ }));
  fireEvent.click(screen.getByRole("button", { name: /新任务/ }));
  await waitFor(() =>
    assert.equal((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value, ""),
  );
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.ok(screen.getByText("一起把目标变成可用的能力"));
  assert.match(
    requests[0].requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(screen.queryByText("无法恢复任务记录"), null);
});

test("docked assistant leaves page interactive and stays open across navigation", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/assistant"))
      return Response.json({
        configuration: { modelId: "model", modelName: "Fixture" },
        canConfigure: false,
        operations: [],
        skills: [],
        sessions: [],
      });
    if (url.endsWith("/assistant/sessions"))
      return Response.json({
        id: "dock-task",
        title: "新会话",
        context: { page: "agents" },
        createdAt: new Date().toISOString(),
      });
    if (url.endsWith("/session")) return Response.json({ messages: [], resumeRun: null });
    if (url.endsWith("/capabilities")) return Response.json({ skills: [] });
    return Response.json([]);
  });
  function Scenario() {
    const [page, setPage] = useState<"agents" | "skills">("agents");
    return (
      <ProjectData projectId="project" owner="dock-owner">
        <PlatformAssistant
          projectId="project"
          projectName="Test"
          user={{
            id: "owner",
            tenantId: "tenant",
            entry: "console",
            displayName: "Owner",
            kind: "user",
          }}
          context={{ page }}
          onNavigate={() => {}}
        >
          <input aria-label="页面草稿" defaultValue="原内容" />
          <button type="button" onClick={() => setPage("skills")}>
            切换到技能页
          </button>
        </PlatformAssistant>
      </ProjectData>
    );
  }
  render(<Scenario />);
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  await screen.findByRole("textbox", { name: "消息" });
  assert.equal(screen.queryByRole("dialog"), null);
  fireEvent.change(screen.getByRole("textbox", { name: "页面草稿" }), {
    target: { value: "人工草稿" },
  });
  fireEvent.click(screen.getByText("切换到技能页"));
  assert.ok(screen.getByRole("textbox", { name: "消息" }));
  assert.equal(
    (screen.getByRole("textbox", { name: "页面草稿" }) as HTMLInputElement).value,
    "人工草稿",
  );
  assert.ok(screen.getByText(/当前页面 · Skills/));
  fireEvent.click(screen.getByRole("button", { name: "收起平台助手" }));
  assert.equal(document.activeElement, screen.getByRole("button", { name: "打开平台助手" }));
  assert.equal(
    (screen.getByRole("textbox", { name: "页面草稿" }) as HTMLInputElement).value,
    "人工草稿",
  );
});

test("automatic chat creation fails once and explicit retry reuses its request ID", async (t) => {
  const requests: { requestId: string }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/assistant"))
      return Response.json({
        configuration: { modelId: "model", modelName: "Fixture" },
        canConfigure: false,
        operations: [],
        skills: [],
        sessions: [],
      });
    if (req.url.endsWith("/assistant/sessions")) {
      requests.push(await req.json());
      if (requests.length === 1)
        return Response.json({ message: "暂时无法创建会话" }, { status: 503 });
      return Response.json({
        id: "retry-task",
        title: "新会话",
        context: { page: "agents" },
        createdAt: new Date().toISOString(),
      });
    }
    if (req.url.endsWith("/session")) return Response.json({ messages: [], resumeRun: null });
    if (req.url.endsWith("/capabilities")) return Response.json({ skills: [] });
    return Response.json([]);
  });
  render(
    <ProjectData projectId="project" owner="retry-owner">
      <PlatformAssistant
        projectId="project"
        projectName="Test"
        user={{
          id: "owner",
          tenantId: "tenant",
          entry: "console",
          displayName: "Owner",
          kind: "user",
        }}
        context={{ page: "agents" }}
        onNavigate={() => {}}
      />
    </ProjectData>,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  await screen.findByText("暂时无法创建会话");
  assert.equal(requests.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "收起平台助手" }));
  fireEvent.click(screen.getByRole("button", { name: "打开平台助手" }));
  assert.equal(requests.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "重新打开对话" }));
  await screen.findByRole("textbox", { name: "消息" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
});
