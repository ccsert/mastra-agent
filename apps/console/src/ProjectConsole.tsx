import {
  ApiOutlined,
  AppstoreOutlined,
  ArrowRightOutlined,
  BookOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CommentOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { Agent, Conversation, Model, Project, Tool } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useIsFetching } from "@tanstack/react-query";
import { type UIMessage, validateUIMessages } from "ai";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type React from "react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { ApplicationsWorkspace } from "./Applications";
import { timestamp, unwrap } from "./api";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { Blank } from "./Blank";
import { useProjectQuery, useProjectRefresh } from "./data/ProjectData";
import { QueryState } from "./data/QueryState";
import { Editor, type EditorKind } from "./Editors";
import { KnowledgeWorkspace } from "./Knowledge";
import { McpWorkspace } from "./Mcp";
import { RunsWorkspace } from "./Runs";
import { useLifetime } from "./useLifetime";

const Chat = lazy(() => import("./Chat").then((module) => ({ default: module.Chat })));
const Workflows = lazy(() =>
  import("./Workflows").then((module) => ({ default: module.WorkflowWorkspace })),
);
type Page =
  | "overview"
  | "agents"
  | "chat"
  | "knowledge"
  | "workflows"
  | "models"
  | "tools"
  | "mcp"
  | "runs"
  | "applications"
  | "runtimes";
const navigation: [Page, string, React.ReactNode][] = [
  ["overview", "工作台", <AppstoreOutlined key="AppstoreOutlined" />],
  ["agents", "Agents", <RobotOutlined key="RobotOutlined" />],
  ["chat", "对话", <CommentOutlined key="CommentOutlined" />],
  ["knowledge", "知识库", <BookOutlined key="knowledge" />],
  ["workflows", "工作流", <BranchesOutlined key="workflows" />],
  ["models", "模型服务", <ApiOutlined key="ApiOutlined" />],
  ["tools", "工具", <ToolOutlined key="ToolOutlined" />],
  ["mcp", "MCP 服务", <ApiOutlined key="mcp" />],
  ["runs", "运行记录", <DeploymentUnitOutlined key="DeploymentUnitOutlined" />],
  ["applications", "应用接入", <CodeOutlined key="CodeOutlined" />],
  ["runtimes", "Runtime", <CloudServerOutlined key="CloudServerOutlined" />],
];
const pageTitles: Record<Page, [string, string]> = {
  overview: ["工作台", "从模型配置到业务调用，管理你的 Agent 项目。"],
  agents: ["Agents", "配置角色与工具，发布可供团队和业务系统使用的智能体。"],
  chat: ["对话", "与已发布的 Agent 协作，历史记录保存在当前项目。"],
  knowledge: ["知识库", "将团队资料转为可检索的知识，供 Agent 按需引用。"],
  workflows: ["工作流", "用自然语言编排业务流程，发布后按固定版本执行。"],
  models: ["模型服务", "登记团队使用的模型服务，并管理调用凭据。"],
  tools: ["工具", "让 Agent 使用经过登记的业务能力。"],
  mcp: ["MCP 服务", "连接业务服务，发现并审阅可供 Agent 使用的工具。"],
  runs: ["运行记录", "查看任务状态、发布版本与工具执行结果。"],
  applications: ["应用接入", "通过 OpenAPI 和生成 SDK，将 Agent 接入业务后端。"],
  runtimes: ["Runtime", "查看承接 Agent 执行的运行服务及连接状态。"],
};
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
  const lifetime = useLifetime();
  const [page, setPage] = useState<Page>("overview"),
    [mobileNav, setMobileNav] = useState(false);
  const modelsQuery = useProjectQuery("models", {
    enabled: ["overview", "agents", "models", "knowledge", "workflows"].includes(page),
  });
  const toolsQuery = useProjectQuery("tools", {
    enabled: ["overview", "tools", "mcp"].includes(page),
  });
  const agentsQuery = useProjectQuery("agents", { enabled: ["overview", "agents"].includes(page) });
  const conversationsQuery = useProjectQuery("conversations", { enabled: page === "chat" });
  const runsQuery = useProjectQuery("runs", {
    enabled: page === "overview",
    poll: page === "overview",
  });
  const runtimesQuery = useProjectQuery("runtimes", { poll: true });
  const models = modelsQuery.data ?? [],
    tools = toolsQuery.data ?? [],
    agents = agentsQuery.data ?? [],
    conversations = conversationsQuery.data ?? [],
    runs = runsQuery.data ?? [],
    runtimes = runtimesQuery.data ?? [];
  const refresh = useProjectRefresh(),
    loading = useIsFetching() > 0;
  const [error, setError] = useState(""),
    [editor, setEditor] = useState<EditorKind | null>(null),
    [editingAgent, setEditingAgent] = useState<Agent>(),
    [publishing, setPublishing] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<UIMessage[] | null>(null);
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
  const conversationRequest = useRef(0);
  const selectedProject = projects.find((p) => p.id === projectId);
  function openEditor(kind: EditorKind, agent?: Agent) {
    setEditingAgent(agent);
    setEditor(kind);
  }
  async function publish(agent: Agent) {
    const signal = lifetime();
    setPublishing(agent.id);
    try {
      const release = await unwrap(
        api.publishAgent({
          signal,
          path: { projectId, id: agent.id },
          body: { baseRevision: agent.draftRevision },
        }),
      );
      if (signal.aborted) return;
      void message.success(`已发布 v${release.version}`);
      await refresh("agents");
    } catch (e) {
      if (!signal.aborted) void message.error(e instanceof Error ? e.message : "发布失败");
    } finally {
      if (!signal.aborted) setPublishing("");
    }
  }
  async function selectConversation(item: Conversation) {
    const signal = lifetime(),
      request = ++conversationRequest.current;
    setError("");
    setConversation(item);
    setMessages(null);
    setPage("chat");
    try {
      const history = await unwrap(api.listMessages({ path: { projectId, id: item.id }, signal }));
      const validated = history.length ? await validateUIMessages({ messages: history }) : [];
      if (!signal.aborted && request === conversationRequest.current) setMessages(validated);
    } catch (e) {
      if (!signal.aborted && request === conversationRequest.current)
        setError(e instanceof Error ? e.message : "无法读取历史");
    }
  }
  async function startChat(agent: Agent) {
    const signal = lifetime(),
      request = ++conversationRequest.current;
    try {
      const item = await unwrap(
        api.createConversation({
          signal,
          path: { projectId },
          body: { agentId: agent.id, title: agent.name },
        }),
      );
      if (signal.aborted || request !== conversationRequest.current) return;
      void refresh("conversations");
      await selectConversation(item);
    } catch (e) {
      if (!signal.aborted && request === conversationRequest.current)
        void message.error(e instanceof Error ? e.message : "创建会话失败");
    }
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
  const agentCards = (items: Agent[]) => (
    <div className="agent-grid">
      {items.map((agent) => (
        <article className="agent-card" key={agent.id}>
          <div className="agent-card-head">
            <span className="agent-icon">
              <RobotOutlined key="RobotOutlined" />
            </span>
            <Tag color={agent.publishedReleaseId ? "success" : "default"}>
              {agent.publishedVersion ? `已发布 v${agent.publishedVersion}` : "草稿"}
            </Tag>
          </div>
          <h3>{agent.name}</h3>
          <p>{agent.description || "为团队提供可复用的 AI 能力"}</p>
          <div className="agent-meta">
            <span>
              <ApiOutlined key="ApiOutlined" />{" "}
              {models.find((m) => m.id === agent.modelId)?.name ?? "模型配置"}
            </span>
            <span>
              <ToolOutlined key="ToolOutlined" /> {agent.toolIds.length} 个工具
            </span>
            {!!agent.knowledgeBaseIds?.length && (
              <span>
                <BookOutlined /> {agent.knowledgeBaseIds.length} 个知识库
              </span>
            )}
          </div>
          <div className="agent-actions">
            <Button onClick={() => openEditor("agent", agent)}>编辑</Button>
            <Button loading={publishing === agent.id} onClick={() => void publish(agent)}>
              发布
            </Button>
            <Button
              type="primary"
              disabled={!agent.publishedReleaseId}
              onClick={() => void startChat(agent)}
            >
              对话 <ArrowRightOutlined key="ArrowRightOutlined" />
            </Button>
          </div>
          <small className="resource-id" title={agent.id}>
            Agent ID · {agent.id}
          </small>
        </article>
      ))}
    </div>
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
          {error && (
            <Alert
              type="error"
              title={error}
              closable={{ onClose: () => setError("") }}
              className="form-alert"
            />
          )}
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
                <>
                  <div className="metrics">
                    {[
                      [
                        <RobotOutlined key="RobotOutlined" />,
                        "Agent",
                        agentsQuery.data?.length ?? "—",
                        agentsQuery.data
                          ? `${agents.filter((a) => a.publishedReleaseId).length} 个已发布`
                          : "等待数据",
                      ],
                      [
                        <ApiOutlined key="ApiOutlined" />,
                        "模型服务",
                        modelsQuery.data?.length ?? "—",
                        "已登记配置",
                      ],
                      [
                        <ToolOutlined key="ToolOutlined" />,
                        "工具",
                        toolsQuery.data?.length ?? "—",
                        "只读与确定性能力",
                      ],
                      [
                        <DeploymentUnitOutlined key="DeploymentUnitOutlined" />,
                        "最近运行",
                        runsQuery.data?.length ?? "—",
                        runsQuery.data
                          ? `${runs.filter((r) => r.status === "succeeded").length} 次成功`
                          : "等待数据",
                      ],
                    ].map(([icon, label, value, note]) => (
                      <section className="metric" key={String(label)}>
                        <span>
                          {icon} {label}
                        </span>
                        <strong>{value}</strong>
                        <small>{note}</small>
                      </section>
                    ))}
                  </div>
                  <QueryState label="模型服务" query={modelsQuery}>
                    {null}
                  </QueryState>
                  <QueryState label="工具" query={toolsQuery}>
                    {null}
                  </QueryState>
                  <QueryState label="运行记录" query={runsQuery}>
                    {null}
                  </QueryState>
                  <section className="onboarding">
                    <div>
                      <span className="eyebrow">从配置到调用</span>
                      <h2>跑通团队的第一条 Agent 链路</h2>
                      <p>模型提供推理能力，工具连接业务，发布版本供平台与应用调用。</p>
                    </div>
                    <div className="onboarding-steps">
                      {[
                        {
                          done: models.length > 0,
                          label: "接入模型",
                          detail: "配置你自己的模型服务",
                          action: () => navigate("models"),
                        },
                        {
                          done: agents.length > 0,
                          label: "创建 Agent",
                          detail: "定义角色与授权工具",
                          action: () => navigate("agents"),
                        },
                        {
                          done: runs.some((r) => r.status === "succeeded"),
                          label: "运行与接入",
                          detail: "对话验证后接入业务系统",
                          action: () => navigate("applications"),
                        },
                      ].map((step, i) => (
                        <button type="button" key={step.label} onClick={step.action}>
                          <span className={step.done ? "step-number done" : "step-number"}>
                            {step.done ? <CheckCircleOutlined key="CheckCircleOutlined" /> : i + 1}
                          </span>
                          <span>
                            <strong>{step.label}</strong>
                            <small>{step.detail}</small>
                          </span>
                          <ArrowRightOutlined key="ArrowRightOutlined" />
                        </button>
                      ))}
                    </div>
                  </section>
                  <div className="section-heading">
                    <h2>项目中的 Agents</h2>
                    <Button type="link" onClick={() => navigate("agents")}>
                      查看全部 <ArrowRightOutlined key="ArrowRightOutlined" />
                    </Button>
                  </div>
                  <QueryState label="Agents" query={agentsQuery}>
                    {agents.length ? (
                      agentCards(agents.slice(0, 3))
                    ) : (
                      <section className="panel">
                        <Blank
                          title="还没有 Agent"
                          description="先接入模型，再创建一个可以使用授权工具的 Agent。"
                          action={
                            <Button onClick={() => openEditor(models.length ? "agent" : "model")}>
                              {models.length ? "创建 Agent" : "接入模型"}
                            </Button>
                          }
                        />
                      </section>
                    )}
                  </QueryState>
                  <div className="scope-note">
                    <ExperimentOutlined key="ExperimentOutlined" />
                    <p>
                      当前已开放 Agent 对话、工具调用与知识库检索。Skills、AI
                      工作流和嵌入组件将继续接入这套平台。
                    </p>
                  </div>
                </>
              )}
              {page === "agents" && (
                <>
                  <QueryState label="模型服务" query={modelsQuery}>
                    {null}
                  </QueryState>
                  <QueryState label="Agents" query={agentsQuery}>
                    {agents.length ? (
                      agentCards(agents)
                    ) : (
                      <section className="panel">
                        <Blank
                          title="创建第一个 Agent"
                          description="为它选择模型，写下角色指令，并绑定允许使用的工具。"
                          action={
                            <Button type="primary" onClick={() => openEditor("agent")}>
                              创建 Agent
                            </Button>
                          }
                        />
                      </section>
                    )}
                  </QueryState>
                </>
              )}
              {page === "knowledge" && (
                <QueryState label="模型服务" query={modelsQuery}>
                  <KnowledgeWorkspace
                    key={projectId}
                    projectId={projectId}
                    models={models}
                    onChanged={() => void refresh("knowledgeBases")}
                    onConfigureModels={() => navigate("models")}
                  />
                </QueryState>
              )}
              {page === "mcp" && (
                <QueryState label="工具" query={toolsQuery}>
                  <McpWorkspace
                    key={projectId}
                    projectId={projectId}
                    tools={tools}
                    onChanged={() => void refresh("tools")}
                  />
                </QueryState>
              )}
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
              {page === "models" && (
                <QueryState label="模型服务" query={modelsQuery}>
                  <section className="panel">
                    <Table<Model>
                      scroll={{ x: 850 }}
                      rowKey="id"
                      dataSource={models}
                      pagination={false}
                      locale={{
                        emptyText: (
                          <Blank
                            title="接入你的模型服务"
                            description="支持 OpenAI 兼容接口，凭据加密保存在平台。"
                            action={<Button onClick={() => openEditor("model")}>接入模型</Button>}
                          />
                        ),
                      }}
                      columns={[
                        {
                          title: "模型服务",
                          dataIndex: "name",
                          render: (_, m) => (
                            <div className="cell-title">
                              <span className="table-icon">
                                <ApiOutlined key="ApiOutlined" />
                              </span>
                              <div>
                                <strong>{m.name}</strong>
                                <small>OpenAI 兼容接口</small>
                              </div>
                            </div>
                          ),
                        },
                        {
                          title: "能力",
                          dataIndex: "kind",
                          render: (kind: Model["kind"], m: Model) => (
                            <Tag>
                              {{ chat: "对话", embedding: "向量", rerank: "重排" }[kind ?? "chat"]}
                              {m.dimensions ? ` · ${m.dimensions} 维` : ""}
                            </Tag>
                          ),
                        },
                        { title: "模型 ID", dataIndex: "modelId", render: (v) => <code>{v}</code> },
                        { title: "服务地址", dataIndex: "baseUrl", ellipsis: true },
                        {
                          title: "凭据",
                          dataIndex: "hasCredential",
                          render: (v) => (
                            <Tag color={v ? "success" : "default"}>
                              {v ? "已加密保存" : "未设置"}
                            </Tag>
                          ),
                        },
                        { title: "登记时间", dataIndex: "createdAt", render: timestamp },
                      ]}
                    />
                  </section>
                </QueryState>
              )}
              {page === "tools" && (
                <QueryState label="工具" query={toolsQuery}>
                  <section className="panel">
                    <Table<Tool>
                      rowKey="id"
                      dataSource={tools}
                      pagination={false}
                      locale={{
                        emptyText: (
                          <Blank
                            title="连接业务能力"
                            description="登记只读 JSON 接口，或用内置求和工具验证 Agent 工具调用。"
                            action={<Button onClick={() => openEditor("tool")}>登记工具</Button>}
                          />
                        ),
                      }}
                      columns={[
                        {
                          title: "工具",
                          dataIndex: "name",
                          render: (_, t) => (
                            <div className="cell-title">
                              <span className="table-icon">
                                <ToolOutlined key="ToolOutlined" />
                              </span>
                              <div>
                                <strong>{t.name}</strong>
                                <small>{t.description}</small>
                              </div>
                            </div>
                          ),
                        },
                        {
                          title: "执行方式",
                          dataIndex: "kind",
                          render: (v) =>
                            v === "sum" ? "内置求和" : v === "mcp" ? "MCP" : "HTTP GET",
                        },
                        { title: "能力范围", render: () => <Tag>只读 / 无业务写入</Tag> },
                        { title: "版本", render: () => <code>v1</code> },
                        { title: "登记时间", dataIndex: "createdAt", render: timestamp },
                      ]}
                    />
                  </section>
                </QueryState>
              )}
              {page === "chat" && (
                <section className="chat-workspace">
                  <aside className="conversation-list">
                    <div className="conversation-list-head">
                      <strong>我的会话</strong>
                      <Button
                        type="text"
                        aria-label="新建会话"
                        icon={<PlusOutlined key="PlusOutlined" />}
                        onClick={() => navigate("agents")}
                      />
                    </div>
                    <QueryState label="会话" query={conversationsQuery}>
                      {conversations.length ? (
                        conversations.map((c) => (
                          <button
                            type="button"
                            key={c.id}
                            className={
                              conversation?.id === c.id
                                ? "conversation-item selected"
                                : "conversation-item"
                            }
                            onClick={() => void selectConversation(c)}
                          >
                            <CommentOutlined key="CommentOutlined" />
                            <span>
                              <strong>{c.title}</strong>
                              <small>
                                v{c.releaseVersion} · {timestamp(c.createdAt)}
                              </small>
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="muted small-pad">从已发布的 Agent 开始一段新对话。</p>
                      )}
                    </QueryState>
                  </aside>
                  <div className="chat-main">
                    {conversation ? (
                      <>
                        <header className="chat-header">
                          <div>
                            <strong>{conversation.title}</strong>
                            <span>会话 {conversation.id.slice(0, 8)}</span>
                          </div>
                          <Tag color="blue">固定版本 v{conversation.releaseVersion}</Tag>
                        </header>
                        {messages ? (
                          <Suspense
                            fallback={
                              <div className="chat-loader">
                                <Spin />
                              </div>
                            }
                          >
                            <Chat
                              key={conversation.id}
                              projectId={projectId}
                              conversationId={conversation.id}
                              messages={messages}
                              onFinish={() => void refresh("runs", "conversations")}
                            />
                          </Suspense>
                        ) : (
                          <div className="chat-loader">
                            <Spin description="恢复会话…" />
                          </div>
                        )}
                      </>
                    ) : (
                      <Blank
                        title="选择一个 Agent 开始对话"
                        description="会话会固定到创建时的发布版本，历史可以随时回来查看。"
                        action={
                          <Button type="primary" onClick={() => navigate("agents")}>
                            选择 Agent
                          </Button>
                        }
                      />
                    )}
                  </div>
                </section>
              )}
              {page === "runs" && <RunsWorkspace projectId={projectId} />}
              {page === "applications" && <ApplicationsWorkspace projectId={projectId} />}
              {page === "runtimes" && (
                <QueryState label="Runtime" query={runtimesQuery}>
                  <div className="runtime-grid">
                    {runtimes.map((r) => (
                      <section className="runtime-card" key={r.id}>
                        <div className="runtime-title">
                          <span>
                            <CloudServerOutlined key="CloudServerOutlined" />
                          </span>
                          <div>
                            <h2>{r.name}</h2>
                            <code>{r.id}</code>
                          </div>
                          <Tag color={r.online ? "success" : "default"}>
                            {r.online ? "在线" : "离线"}
                          </Tag>
                        </div>
                        <dl>
                          <div>
                            <dt>部署位置</dt>
                            <dd>平台托管</dd>
                          </div>
                          <div>
                            <dt>连接方式</dt>
                            <dd>主动连接控制面</dd>
                          </div>
                          <div>
                            <dt>最近连接</dt>
                            <dd>{r.lastSeenAt ? timestamp(r.lastSeenAt) : "尚未连接"}</dd>
                          </div>
                          <div>
                            <dt>执行能力</dt>
                            <dd>Agent · 授权只读工具</dd>
                          </div>
                        </dl>
                        <p>Runtime 独立执行任务，并回传消息与工具事件。</p>
                      </section>
                    ))}
                  </div>
                </QueryState>
              )}
            </>
          )}
        </main>
      </div>
      <Editor
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
                  application: "applications",
                } as const
              )[editor],
            );
        }}
      />
    </div>
  );
}
