import {
  DeploymentUnitOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { Agent, Project } from "@platform/sdk";
import { useIsFetching } from "@tanstack/react-query";
import { Badge, Button, Drawer, Select, Tag, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Blank } from "../shared/Blank";
import { useProjectQuery, useProjectRefresh } from "../shared/data/ProjectData";
import { projectPath } from "../shared/navigation";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { EditorHost, type EditorKind } from "./EditorHost";
import { navigation, type Page, pageTitles } from "./navigation";
import type { ConsoleNavigation } from "./routing/context";
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
  const location = useLocation();
  const { registerGuard, confirmExit } = useNavigationGuard();
  const agentsQuery = useProjectQuery("agents", { enabled: false });
  const runtimesQuery = useProjectQuery("runtimes", { poll: true });
  const agents = agentsQuery.data ?? [],
    runtimes = runtimesQuery.data ?? [];
  const refresh = useProjectRefresh(),
    loading = useIsFetching() > 0;
  const [editing, setEditing] = useState<{ kind: EditorKind; agent?: Agent; pathname: string }>();
  if (editing && editing.pathname !== location.pathname) setEditing(undefined);
  if (mobilePath && mobilePath !== location.pathname) setMobilePath(undefined);
  const editor = editing?.kind ?? null,
    editingAgent = editing?.agent;

  const selectedProject = projects.find((p) => p.id === projectId);
  function openEditor(kind: EditorKind, agent?: Agent) {
    setEditing({ kind, agent, pathname: location.pathname });
  }
  useEffect(() => {
    document.title = `${pageTitles[page][0]} · ${selectedProject?.name ?? "工作空间"} · Agent Platform`;
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
        {navigation.map(([key, label, icon]) => (
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
              onClick={() => void confirmExit(logout)}
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
        open={mobilePath === location.pathname}
        onClose={() => setMobilePath(undefined)}
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
            <Outlet context={{ page, openEditor, registerGuard } satisfies ConsoleNavigation} />
          )}
        </main>
      </div>
      <EditorHost
        key={`${editor ?? "closed"}:${editingAgent?.id ?? "new"}`}
        kind={editor}
        projectId={projectId}
        agent={editingAgent}
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
  );
}
