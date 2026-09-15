import {
  DeploymentUnitOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  ReloadOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import type { Agent, Model, Project, Tool } from "@platform/sdk";
import { useIsFetching } from "@tanstack/react-query";
import { Badge, Button, Drawer, Select, Tag, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate, useParams } from "react-router";
import { PlatformAssistant } from "../features/assistant/index";
import { ProjectAccessContext, pagePermission, roleNames } from "../shared/access";
import { Blank } from "../shared/Blank";
import { useProjectQuery, useProjectRefresh } from "../shared/data/ProjectData";
import { QueryState } from "../shared/data/QueryState";
import { pages, projectPath } from "../shared/navigation";
import { PageActionsProvider } from "../shared/PageActions";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { EditorHost, type EditorKind } from "./EditorHost";
import { navigation, type Page, pageTitles } from "./navigation";
import type { ConsoleNavigation, EditorResource } from "./routing/context";
import { useNavigationGuard } from "./routing/NavigationGuard";

export function ProjectConsole({
  user,
  logout,
  projects,
  projectId,
  page,
  onProjectChange,
  refreshProjects,
}: ConsoleSession & {
  projects: Project[];
  projectId: string;
  page: Page;
  onProjectChange(id: string): void;
  refreshProjects(chooseNewest?: boolean): Promise<void>;
}) {
  const [mobilePath, setMobilePath] = useState<string>();
  const { resourceId } = useParams();
  const location = useLocation(),
    navigate = useNavigate();
  const accessQuery = useProjectQuery("access", { poll: 15000 });
  const access = accessQuery.data;
  const allowed = (permission: string) =>
    access?.permissions?.some((p) => p === permission) ?? false;
  const tenantRole = access?.tenantRole ?? user.tenantRole;
  const teamAdmin = tenantRole === "owner" || tenantRole === "admin";
  const authoringPage = !!useMatch("/projects/:projectId/agents/:resourceId");
  const conversationPage = !!useMatch("/projects/:projectId/chat/:resourceId");
  const { registerGuard, confirmExit, canNavigate } = useNavigationGuard();
  const agentsQuery = useProjectQuery("agents", { enabled: false });
  const runtimesQuery = useProjectQuery("runtimes", { poll: true });
  const agents = agentsQuery.data ?? [],
    runtimes = runtimesQuery.data ?? [];
  const refresh = useProjectRefresh(),
    loading = useIsFetching() > 0;
  const [editing, setEditing] = useState<{
    kind: EditorKind;
    resource?: EditorResource;
    pathname: string;
  }>();
  if (editing && editing.pathname !== location.pathname) setEditing(undefined);
  if (mobilePath && mobilePath !== location.pathname) setMobilePath(undefined);
  const editor = editing?.kind ?? null,
    editingAgent = editing?.kind === "agent" ? (editing.resource as Agent | undefined) : undefined,
    editingModel = editing?.kind === "model" ? (editing.resource as Model | undefined) : undefined,
    editingTool = editing?.kind === "tool" ? (editing.resource as Tool | undefined) : undefined;

  const selectedProject = projects.find((p) => p.id === projectId);
  function openEditor(kind: EditorKind, resource?: EditorResource) {
    if (kind === "agent") {
      void navigate(projectPath(projectId, "agents", resource?.id ?? "new"));
      return;
    }
    setEditing({ kind, resource, pathname: location.pathname });
  }
  useEffect(() => {
    document.title =
      page === "team"
        ? "团队设置 · Agent Platform"
        : `${pageTitles[page][0]} · ${selectedProject?.name ?? "工作空间"} · Agent Platform`;
  }, [page, selectedProject?.name]);
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
        {navigation
          .filter(([key]) => allowed(pagePermission(key)))
          .map(([key, label, icon]) => (
            <Link
              to={projectId ? projectPath(projectId, key) : "/"}
              key={key}
              aria-label={label}
              className={page === key ? "nav-item active" : "nav-item"}
              aria-current={page === key ? "page" : undefined}
            >
              {icon}
              <span>{label}</span>
              {key === "agents" && agents.length > 0 && <b>{agents.length}</b>}
            </Link>
          ))}
      </nav>
      <div className="sidebar-bottom">
        {teamAdmin && (
          <Link
            to="/team"
            state={{ projectId }}
            className={page === "team" ? "nav-item active" : "nav-item"}
          >
            <TeamOutlined />
            <span>团队设置</span>
          </Link>
        )}
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
            <small>
              {tenantRole === "owner"
                ? "团队所有者"
                : access?.role
                  ? `项目${roleNames[access.role]}`
                  : tenantRole === "admin"
                    ? "团队管理员"
                    : "团队成员"}
            </small>
          </span>
          <Tooltip title="退出登录">
            <Button
              type="text"
              aria-label="退出登录"
              icon={<LogoutOutlined key="LogoutOutlined" />}
              onClick={() => void confirmExit(logout)}
            />
          </Tooltip>
        </div>
      </div>
    </>
  );
  const assistantNavigate = async (target: Page, id?: string) => {
    if (!pages.includes(target) || !allowed(pagePermission(target)) || target === "team")
      throw new Error("当前页面不可由助手打开");
    if (!canNavigate()) throw new Error("当前有未保存草稿或正在执行的操作，请先由用户处理");
    await navigate(projectPath(projectId, target, id));
  };
  return (
    <PageActionsProvider
      key={projectId}
      page={page}
      resourceId={resourceId === "new" ? undefined : resourceId}
      locationKey={location.pathname}
      onNavigate={assistantNavigate}
      targets={
        page === "agents" && !resourceId && allowed("agent.edit")
          ? [
              {
                id: "agent.create",
                label: "打开创建 Agent 草稿",
                kind: "click",
                execute: () => assistantNavigate("agents", "new"),
              },
            ]
          : []
      }
    >
      <div className="platform-shell">
        <aside className="sidebar">{nav}</aside>
        <Drawer
          placement="left"
          size={250}
          open={mobilePath === location.pathname}
          onClose={() => setMobilePath(undefined)}
          styles={{ body: { padding: 0 } }}
        >
          <div className="mobile-sidebar">{nav}</div>
        </Drawer>
        <div className="workspace">
          <ProjectAccessContext.Provider value={access}>
            <PlatformAssistant
              key={`${user.id}/${projectId}`}
              available={!!projectId && allowed("project.read")}
              projectId={projectId}
              projectName={selectedProject?.name ?? "当前项目"}
              user={user}
              context={{
                page,
                ...(resourceId && resourceId !== "new" ? { resourceId } : {}),
              }}
              onNavigate={(target, id, targetProjectId) => {
                const next = pages.find((p) => p === target);
                if (next)
                  void confirmExit(async () => {
                    await refreshProjects();
                    await navigate(
                      next === "team"
                        ? "/team"
                        : projectPath(targetProjectId ?? projectId, next, id),
                    );
                  });
              }}
              renderHeader={(assistantTrigger) => (
                <header className="topbar">
                  <div className="topbar-project">
                    <Button
                      type="text"
                      className="mobile-menu"
                      aria-label="打开导航"
                      icon={<MenuOutlined key="MenuOutlined" />}
                      onClick={() => setMobilePath(location.pathname)}
                    />
                    <FolderOpenOutlined key="FolderOpenOutlined" />
                    <Select
                      aria-label="当前项目"
                      variant="borderless"
                      placeholder="选择项目"
                      value={projectId || undefined}
                      options={projects.map((p) => ({ value: p.id, label: p.name }))}
                      onChange={(id) => {
                        if (id !== projectId) onProjectChange(id);
                      }}
                      popupMatchSelectWidth={240}
                    />
                    <Tag>开发环境</Tag>
                    {!conversationPage && !authoringPage && (
                      <h1 className="topbar-page">{pageTitles[page][0]}</h1>
                    )}
                  </div>
                  <div className="topbar-actions">
                    {projectId &&
                      !conversationPage &&
                      !authoringPage &&
                      ["agents", "models", "tools"].includes(page) &&
                      allowed(page === "agents" ? "agent.edit" : "resource.manage") && (
                        <Button
                          data-agent-target={page === "agents" ? "agent.create" : undefined}
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
                    {assistantTrigger}

                    <Button
                      type="text"
                      icon={<PlusOutlined key="PlusOutlined" />}
                      disabled={!teamAdmin}
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
              )}
            >
              <main
                data-agent-target="page"
                className={`main-content page-${page}${conversationPage ? " conversation-page" : ""}${authoringPage ? " agent-authoring-page" : ""}`}
              >
                {!projectId && page !== "team" ? (
                  <section className="panel">
                    <Blank
                      title={teamAdmin ? "创建你的第一个项目" : "等待项目邀请"}
                      description={
                        teamAdmin
                          ? "用项目组织模型、工具、Agent 与会话，让业务团队从这里开始。"
                          : "你已加入团队，请联系管理员将你添加到项目。"
                      }
                      action={
                        <Button
                          type="primary"
                          icon={<PlusOutlined key="PlusOutlined" />}
                          disabled={!teamAdmin}
                          onClick={() => openEditor("project")}
                        >
                          创建项目
                        </Button>
                      }
                    />
                  </section>
                ) : (
                  <ProjectAccessContext.Provider value={access}>
                    {page === "team" ? (
                      <Outlet
                        context={
                          { page, user, openEditor, registerGuard } satisfies ConsoleNavigation
                        }
                      />
                    ) : (
                      <QueryState label="项目权限" query={accessQuery}>
                        <Outlet
                          context={
                            { page, user, openEditor, registerGuard } satisfies ConsoleNavigation
                          }
                        />
                      </QueryState>
                    )}
                  </ProjectAccessContext.Provider>
                )}
              </main>
            </PlatformAssistant>
          </ProjectAccessContext.Provider>
        </div>
        <EditorHost
          key={`${editor ?? "closed"}:${editing?.resource?.id ?? "new"}`}
          kind={editor}
          projectId={projectId}
          agent={editingAgent}
          model={editingModel}
          tool={editingTool}
          onClose={() => setEditing(undefined)}
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
    </PageActionsProvider>
  );
}
