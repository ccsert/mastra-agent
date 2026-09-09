import {
  DeploymentUnitOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { Agent, Conversation, Project } from "@platform/sdk";
import { useIsFetching } from "@tanstack/react-query";
import { App as AntApp, Badge, Button, Drawer, Select, Spin, Tag, Tooltip } from "antd";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { AgentCollection } from "../features/agents/index";
import { ApplicationsWorkspace } from "../features/applications/index";
import { ChatWorkspace } from "../features/chat/index";
import { KnowledgeWorkspace } from "../features/knowledge/index";
import { McpWorkspace } from "../features/mcp/index";
import { ModelWorkspace } from "../features/models/index";
import { Overview } from "../features/overview/index";
import { RunsWorkspace } from "../features/runs/index";
import { RuntimeInfoWorkspace } from "../features/runtimes/index";
import { SkillWorkspace } from "../features/skills/index";
import { ToolWorkspace } from "../features/tools/index";
import { Blank } from "../shared/Blank";
import { useProjectQuery, useProjectRefresh } from "../shared/data/ProjectData";
import { QueryState } from "../shared/data/QueryState";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { EditorHost, type EditorKind } from "./EditorHost";
import { navigation, type Page, pageTitles } from "./navigation";

const Workflows = lazy(() =>
  import("../features/workflows/index").then((module) => ({ default: module.WorkflowWorkspace })),
);
export function ProjectConsole({
  user,
  logout,
  projects,
  projectId,
  onProjectChange,
  refreshProjects,
}: ConsoleSession & {
  projects: Project[];
  projectId: string;
  onProjectChange(id: string): void;
  refreshProjects(chooseNewest?: boolean): Promise<void>;
}) {
  const { message, modal } = AntApp.useApp();
  const [page, setPage] = useState<Page>("overview"),
    [mobileNav, setMobileNav] = useState(false);
  const modelsQuery = useProjectQuery("models", {
    enabled: ["knowledge", "workflows"].includes(page),
  });
  const agentsQuery = useProjectQuery("agents", { enabled: false });
  const runtimesQuery = useProjectQuery("runtimes", { poll: true });
  const models = modelsQuery.data ?? [],
    agents = agentsQuery.data ?? [],
    runtimes = runtimesQuery.data ?? [];
  const refresh = useProjectRefresh(),
    loading = useIsFetching() > 0;
  const [editor, setEditor] = useState<EditorKind | null>(null),
    [editingAgent, setEditingAgent] = useState<Agent>();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const workflowGuard = useRef<(() => "busy" | "dirty" | null) | undefined>(undefined);
  const registerWorkflowGuard = useCallback((guard?: () => "busy" | "dirty" | null) => {
    workflowGuard.current = guard;
  }, []);
  const leaveWorkflow = (action: () => void) => {
    const reason = workflowGuard.current?.();
    if (reason === "busy") {
      message.info("请等待当前工作流操作完成");
      return;
    }
    if (reason === "dirty") {
      modal.confirm({
        title: "离开未保存的草稿？",
        content: "当前修改尚未保存，可以先保存后再离开。",
        okText: "离开",
        cancelText: "继续编辑",
        onOk: action,
      });
    } else action();
  };
  const selectedProject = projects.find((p) => p.id === projectId);
  function openEditor(kind: EditorKind, agent?: Agent) {
    setEditingAgent(agent);
    setEditor(kind);
  }
  function selectConversation(item: Conversation) {
    setConversation(item);
    setPage("chat");
  }
  function navigate(next: Page) {
    if (next === page) {
      setMobileNav(false);
      return;
    }
    leaveWorkflow(() => {
      setPage(next);
      setMobileNav(false);
    });
  }
  const nav = (
    <>
      <div className="brand">
        <span className="brand-mark">
          <DeploymentUnitOutlined key="DeploymentUnitOutlined" />
        </span>
        <strong>
          Agent Platform<small>企业智能体平台</small>
        </strong>
      </div>
      <div className="sidebar-label">工作空间</div>
      <nav>
        {navigation.map(([key, label, icon]) => (
          <button
            type="button"
            key={key}
            aria-label={label}
            className={page === key ? "nav-item active" : "nav-item"}
            onClick={() => navigate(key)}
            aria-current={page === key ? "page" : undefined}
          >
            {icon}
            <span>{label}</span>
            {key === "agents" && agents.length > 0 && <b>{agents.length}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="connection">
          <Badge
            status={
              runtimesQuery.error
                ? "warning"
                : runtimes.some((r) => r.online)
                  ? "success"
                  : "default"
            }
          />
          <span>
            {runtimesQuery.error
              ? "Runtime 状态更新失败"
              : !runtimesQuery.data
                ? "正在读取 Runtime 状态"
                : runtimes.some((r) => r.online)
                  ? "Runtime 已连接"
                  : "等待 Runtime 连接"}
          </span>
        </div>
        <div className="user-row">
          <span className="user-avatar">{user.displayName[0]?.toUpperCase()}</span>
          <span>
            {user.displayName}
            <small>项目管理员</small>
          </span>
          <Tooltip title="退出登录">
            <Button
              type="text"
              aria-label="退出登录"
              icon={<LogoutOutlined key="LogoutOutlined" />}
              onClick={() => leaveWorkflow(() => void logout())}
            />
          </Tooltip>
        </div>
      </div>
    </>
  );
  return (
    <div className="platform-shell">
      <aside className="sidebar">{nav}</aside>
      <Drawer
        placement="left"
        size={250}
        open={mobileNav}
        onClose={() => setMobileNav(false)}
        styles={{ body: { padding: 0 } }}
      >
        <div className="mobile-sidebar">{nav}</div>
      </Drawer>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-project">
            <Button
              type="text"
              className="mobile-menu"
              aria-label="打开导航"
              icon={<MenuOutlined key="MenuOutlined" />}
              onClick={() => setMobileNav(true)}
            />
            <FolderOpenOutlined key="FolderOpenOutlined" />
            <Select
              aria-label="当前项目"
              variant="borderless"
              placeholder="选择项目"
              value={projectId || undefined}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(id) => {
                if (id !== projectId) leaveWorkflow(() => onProjectChange(id));
              }}
              popupMatchSelectWidth={240}
            />
            <Tag>开发环境</Tag>
          </div>
          <div className="topbar-actions">
            <Button
              type="text"
              icon={<PlusOutlined key="PlusOutlined" />}
              onClick={() => openEditor("project")}
            >
              新建项目
            </Button>
            <Tooltip title="刷新数据">
              <Button
                aria-label="刷新数据"
                type="text"
                icon={<ReloadOutlined spin={loading} />}
                onClick={() => void refresh()}
              />
            </Tooltip>
          </div>
        </header>
        <main className={`main-content page-${page}`}>
          <div className="page-heading">
            <div>
              <div className="breadcrumb">
                {selectedProject?.name ?? "工作空间"} <span>/</span> {pageTitles[page][0]}
              </div>
              <h1>{pageTitles[page][0]}</h1>
              <p>{pageTitles[page][1]}</p>
            </div>
            {projectId && ["agents", "models", "tools"].includes(page) && (
              <Button
                type="primary"
                icon={<PlusOutlined key="PlusOutlined" />}
                onClick={() =>
                  openEditor(
                    (
                      {
                        agents: "agent",
                        models: "model",
                        tools: "tool",
                      } as Record<string, EditorKind>
                    )[page],
                  )
                }
              >
                {
                  (
                    {
                      agents: "创建 Agent",
                      models: "接入模型",
                      tools: "登记工具",
                    } as Record<string, string>
                  )[page]
                }
              </Button>
            )}
          </div>
          {!projectId ? (
            <section className="panel">
              <Blank
                title="创建你的第一个项目"
                description="用项目组织模型、工具、Agent 与会话，让业务团队从这里开始。"
                action={
                  <Button
                    type="primary"
                    icon={<PlusOutlined key="PlusOutlined" />}
                    onClick={() => openEditor("project")}
                  >
                    创建项目
                  </Button>
                }
              />
            </section>
          ) : (
            <>
              {page === "overview" && (
                <Overview
                  navigate={navigate}
                  onEdit={(agent) => openEditor("agent", agent)}
                  onConversation={selectConversation}
                />
              )}
              {page === "agents" && (
                <AgentCollection
                  onEdit={(agent) => openEditor("agent", agent)}
                  onConversation={selectConversation}
                />
              )}
              {page === "knowledge" && (
                <QueryState label="模型服务" query={modelsQuery}>
                  <KnowledgeWorkspace
                    key={projectId}
                    projectId={projectId}
                    models={models}
                    onConfigureModels={() => navigate("models")}
                  />
                </QueryState>
              )}
              {page === "skills" && <SkillWorkspace key={projectId} />}
              {page === "mcp" && <McpWorkspace projectId={projectId} />}
              {page === "workflows" && (
                <QueryState label="模型服务" query={modelsQuery}>
                  <Suspense fallback={<Spin />}>
                    <Workflows
                      key={projectId}
                      projectId={projectId}
                      models={models}
                      registerGuard={registerWorkflowGuard}
                    />
                  </Suspense>
                </QueryState>
              )}
              {page === "models" && <ModelWorkspace onCreate={() => openEditor("model")} />}
              {page === "tools" && <ToolWorkspace onCreate={() => openEditor("tool")} />}
              {page === "chat" && (
                <ChatWorkspace
                  conversation={conversation}
                  onSelect={selectConversation}
                  onCreate={() => navigate("agents")}
                />
              )}
              {page === "runs" && <RunsWorkspace projectId={projectId} />}
              {page === "applications" && <ApplicationsWorkspace projectId={projectId} />}
              {page === "runtimes" && <RuntimeInfoWorkspace />}
            </>
          )}
        </main>
      </div>
      <EditorHost
        key={`${editor ?? "closed"}:${editingAgent?.id ?? "new"}`}
        kind={editor}
        projectId={projectId}
        agent={editingAgent}
        onClose={() => setEditor(null)}
        onSaved={() => {
          if (editor === "project") void refreshProjects(true);
          else if (editor)
            void refresh(
              (
                {
                  model: "models",
                  tool: "tools",
                  agent: "agents",
                } as const
              )[editor],
              "workflowCatalog",
            );
        }}
      />
    </div>
  );
}
