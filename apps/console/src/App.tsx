import {
  ApiOutlined,
  AppstoreOutlined,
  ArrowRightOutlined,
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
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type {
  Agent,
  Application,
  Conversation,
  Model,
  Principal,
  Project,
  Run,
  RunEvent,
  RuntimeInfo,
  Tool,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import { type UIMessage, validateUIMessages } from "ai";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type React from "react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { timestamp, unwrap } from "./api";
import { Editor, type EditorKind } from "./Editors";

const Chat = lazy(() => import("./Chat").then((module) => ({ default: module.Chat })));
type Page =
  | "overview"
  | "agents"
  | "chat"
  | "models"
  | "tools"
  | "runs"
  | "applications"
  | "runtimes";
const navigation: [Page, string, React.ReactNode][] = [
  ["overview", "工作台", <AppstoreOutlined key="AppstoreOutlined" />],
  ["agents", "Agents", <RobotOutlined key="RobotOutlined" />],
  ["chat", "对话", <CommentOutlined key="CommentOutlined" />],
  ["models", "模型服务", <ApiOutlined key="ApiOutlined" />],
  ["tools", "工具", <ToolOutlined key="ToolOutlined" />],
  ["runs", "运行记录", <DeploymentUnitOutlined key="DeploymentUnitOutlined" />],
  ["applications", "应用接入", <CodeOutlined key="CodeOutlined" />],
  ["runtimes", "Runtime", <CloudServerOutlined key="CloudServerOutlined" />],
];
const pageTitles: Record<Page, [string, string]> = {
  overview: ["工作台", "从模型配置到业务调用，管理你的 Agent 项目。"],
  agents: ["Agents", "配置角色与工具，发布可供团队和业务系统使用的智能体。"],
  chat: ["对话", "与已发布的 Agent 协作，历史记录保存在当前项目。"],
  models: ["模型服务", "登记团队使用的模型服务，并管理调用凭据。"],
  tools: ["工具", "让 Agent 使用经过登记的业务能力。"],
  runs: ["运行记录", "查看任务状态、发布版本与工具执行结果。"],
  applications: ["应用接入", "通过 OpenAPI 和生成 SDK，将 Agent 接入业务后端。"],
  runtimes: ["Runtime", "查看承接 Agent 执行的运行服务及连接状态。"],
};
const statusNames: Record<Run["status"], string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};
const statusColors: Record<Run["status"], string> = {
  queued: "default",
  running: "processing",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
};
function RunStatus({ status }: { status: Run["status"] }) {
  return <Tag color={statusColors[status]}>{statusNames[status]}</Tag>;
}
function Blank({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="blank-state">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <>
            <h3>{title}</h3>
            <p>{description}</p>
          </>
        }
      >
        {action}
      </Empty>
    </div>
  );
}
export function App() {
  const { message } = AntApp.useApp();
  const [user, setUser] = useState<Principal | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [authReady, setAuthReady] = useState(false),
    [authError, setAuthError] = useState(""),
    [authBusy, setAuthBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [page, setPage] = useState<Page>("overview"),
    [mobileNav, setMobileNav] = useState(false);
  const [models, setModels] = useState<Model[]>([]),
    [tools, setTools] = useState<Tool[]>([]),
    [agents, setAgents] = useState<Agent[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [applications, setApplications] = useState<Application[]>([]),
    [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [editor, setEditor] = useState<EditorKind | null>(null),
    [editingAgent, setEditingAgent] = useState<Agent>(),
    [publishing, setPublishing] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<UIMessage[] | null>(null),
    [runDetail, setRunDetail] = useState<Run | null>(null),
    [events, setEvents] = useState<RunEvent[]>([]),
    [eventsMore, setEventsMore] = useState(false),
    [eventsLoading, setEventsLoading] = useState(false),
    [credential, setCredential] = useState<(Application & { secretKey: string }) | null>(null);
  const conversationRequest = useRef(0),
    detailRequest = useRef(0);
  const selectedProject = projects.find((p) => p.id === projectId),
    projectRef = useRef(projectId);
  projectRef.current = projectId;
  useEffect(() => {
    void (async () => {
      try {
        const status = await unwrap(api.getSetupStatus());
        setInitialized(status.initialized);
        if (status.initialized) {
          const result = await api.getCurrentUser();
          setUser(result.data ?? null);
        }
      } catch (e) {
        setAuthError(e instanceof Error ? e.message : "无法连接平台");
      } finally {
        setAuthReady(true);
      }
    })();
  }, []);
  const refreshProjects = useCallback(async (chooseNewest = false) => {
    const items = await unwrap(api.listProjects());
    setProjects(items);
    setProjectId((current) =>
      chooseNewest
        ? (items.at(-1)?.id ?? "")
        : items.some((p) => p.id === current)
          ? current
          : (items[0]?.id ?? ""),
    );
  }, []);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const path = { projectId };
      const result = await Promise.all([
        unwrap(api.listModels({ path })),
        unwrap(api.listTools({ path })),
        unwrap(api.listAgents({ path })),
        unwrap(api.listConversations({ path })),
        unwrap(api.listRuns({ path })),
        unwrap(api.listApplications({ path })),
        unwrap(api.listRuntimes()),
      ]);
      if (projectRef.current !== projectId) return;
      setModels(result[0]);
      setTools(result[1]);
      setAgents(result[2]);
      setConversations(result[3]);
      setRuns(result[4]);
      setApplications(result[5]);
      setRuntimes(result[6]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (projectRef.current === projectId) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    if (user) void refreshProjects().catch((e) => setError(e.message));
  }, [user, refreshProjects]);
  useEffect(() => {
    conversationRequest.current++;
    setConversation(null);
    setMessages(null);
    setModels([]);
    setTools([]);
    setAgents([]);
    setConversations([]);
    setRuns([]);
    setApplications([]);
    if (user) void refresh();
  }, [user, refresh]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      void unwrap(api.listRuntimes())
        .then(setRuntimes)
        .catch(() => {});
      const id = projectRef.current;
      if (id)
        void unwrap(api.listRuns({ path: { projectId: id } }))
          .then((items) => {
            if (projectRef.current === id) setRuns(items);
          })
          .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [user]);
  async function signIn(values: { username: string; password: string; workspaceName?: string }) {
    setAuthBusy(true);
    setAuthError("");
    try {
      const principal = initialized
        ? await unwrap(
            api.login({ body: { username: values.username, password: values.password } }),
          )
        : await unwrap(
            api.setupPlatform({
              body: {
                username: values.username,
                password: values.password,
                workspaceName: values.workspaceName ?? "我的组织",
              },
            }),
          );
      setUser(principal);
      setInitialized(true);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setAuthBusy(false);
    }
  }
  function openEditor(kind: EditorKind, agent?: Agent) {
    setEditingAgent(agent);
    setEditor(kind);
  }
  async function publish(agent: Agent) {
    setPublishing(agent.id);
    try {
      const release = await unwrap(
        api.publishAgent({
          path: { projectId, id: agent.id },
          body: { baseRevision: agent.draftRevision },
        }),
      );
      void message.success(`已发布 v${release.version}`);
      await refresh();
    } catch (e) {
      void message.error(e instanceof Error ? e.message : "发布失败");
    } finally {
      setPublishing("");
    }
  }
  async function selectConversation(item: Conversation) {
    const request = ++conversationRequest.current;
    setError("");
    setConversation(item);
    setMessages(null);
    setPage("chat");
    try {
      const history = await unwrap(api.listMessages({ path: { projectId, id: item.id } }));
      const validated = history.length ? await validateUIMessages({ messages: history }) : [];
      if (request === conversationRequest.current) setMessages(validated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取历史");
    }
  }
  async function startChat(agent: Agent) {
    try {
      const item = await unwrap(
        api.createConversation({
          path: { projectId },
          body: { agentId: agent.id, title: agent.name },
        }),
      );
      setConversations((current) => [item, ...current]);
      await selectConversation(item);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : "创建会话失败");
    }
  }
  async function inspectRun(run: Run, append = false) {
    const request = ++detailRequest.current;
    setRunDetail(run);
    setEventsLoading(true);
    if (!append) {
      setEvents([]);
      setEventsMore(false);
    }
    try {
      const [batch, current] = await Promise.all([
        unwrap(
          api.listRunEvents({
            path: { projectId, id: run.id },
            query: { after: append ? (events.at(-1)?.seq ?? -1) : -1 },
          }),
        ),
        unwrap(api.getRun({ path: { projectId, id: run.id } })),
      ]);
      if (request !== detailRequest.current) return;
      setRunDetail(current);
      setEvents((previous) => (append ? [...previous, ...batch] : batch));
      setEventsMore(batch.length === 500);
    } catch (e) {
      void message.error(e instanceof Error ? e.message : "读取事件失败");
    } finally {
      if (request === detailRequest.current) setEventsLoading(false);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setMobileNav(false);
  }
  async function logout() {
    await unwrap(api.logout({ body: {} }));
    setUser(null);
    setProjectId("");
    setProjects([]);
    setConversation(null);
    setMessages(null);
  }
  if (!authReady)
    return (
      <div className="full-loader">
        <Spin description="连接平台…" />
      </div>
    );
  if (!user)
    return (
      <div className="auth-screen">
        <div className="auth-story">
          <div className="brand">
            <span className="brand-mark">
              <DeploymentUnitOutlined key="DeploymentUnitOutlined" />
            </span>
            <strong>Agent Platform</strong>
          </div>
          <div>
            <div className="eyebrow">企业智能体平台</div>
            <h1>
              让 AI 能力
              <br />
              进入业务日常。
            </h1>
            <p>
              在同一个项目中连接模型、工具与业务应用，
              <br />
              发布 Agent，并追踪每一次执行。
            </p>
            <div className="auth-flow">
              <span>
                <ApiOutlined key="ApiOutlined" /> 模型
              </span>
              <i />
              <span>
                <RobotOutlined key="RobotOutlined" /> Agent
              </span>
              <i />
              <span>
                <ThunderboltOutlined key="ThunderboltOutlined" /> 业务
              </span>
            </div>
          </div>
          <small>集中管理 · 独立运行 · 按版本发布</small>
        </div>
        <div className="auth-panel">
          <div className="auth-form">
            <span className="eyebrow">{initialized ? "欢迎回来" : "开始使用"}</span>
            <h2>{initialized ? "登录工作空间" : "初始化你的平台"}</h2>
            <p>
              {initialized
                ? "登录后继续管理你的 Agent 和业务项目。"
                : "创建组织与首位管理员，然后接入自己的模型服务。"}
            </p>
            {authError && <Alert type="error" title={authError} className="form-alert" />}
            <Form layout="vertical" onFinish={signIn} requiredMark={false}>
              {!initialized && (
                <Form.Item
                  name="workspaceName"
                  label="组织名称"
                  rules={[{ required: true, message: "请输入组织名称" }]}
                >
                  <Input size="large" placeholder="你的团队或组织" />
                </Form.Item>
              )}
              <Form.Item
                name="username"
                label="账号"
                rules={[
                  { required: true, message: "请输入账号" },
                  {
                    pattern: /^[a-zA-Z0-9_-]{3,50}$/,
                    message: "使用 3–50 位字母、数字、下划线或连字符",
                  },
                ]}
              >
                <Input size="large" autoComplete="username" placeholder="输入账号" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码"
                rules={[
                  { required: true, message: "请输入密码" },
                  { min: 12, message: "密码至少 12 位" },
                ]}
              >
                <Input.Password
                  size="large"
                  autoComplete={initialized ? "current-password" : "new-password"}
                  placeholder="至少 12 位"
                />
              </Form.Item>
              <Button block type="primary" htmlType="submit" size="large" loading={authBusy}>
                {initialized ? "登录" : "创建并进入平台"}
                <ArrowRightOutlined key="ArrowRightOutlined" />
              </Button>
            </Form>
            <p className="auth-hint">当前提供本地帐号登录，统一身份中心接入将在后续交付。</p>
          </div>
        </div>
      </div>
    );
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
          <Badge status={runtimes.some((r) => r.online) ? "success" : "default"} />
          <span>{runtimes.some((r) => r.online) ? "Runtime 已连接" : "等待 Runtime 连接"}</span>
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
              onClick={() => void logout()}
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
              onChange={setProjectId}
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
            {projectId && ["agents", "models", "tools", "applications"].includes(page) && (
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
                        applications: "application",
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
                      applications: "创建应用",
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
                        agents.length,
                        `${agents.filter((a) => a.publishedReleaseId).length} 个已发布`,
                      ],
                      [<ApiOutlined key="ApiOutlined" />, "模型服务", models.length, "已登记配置"],
                      [
                        <ToolOutlined key="ToolOutlined" />,
                        "工具",
                        tools.length,
                        "只读与确定性能力",
                      ],
                      [
                        <DeploymentUnitOutlined key="DeploymentUnitOutlined" />,
                        "最近运行",
                        runs.length,
                        `${runs.filter((r) => r.status === "succeeded").length} 次成功`,
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
                  <div className="scope-note">
                    <ExperimentOutlined key="ExperimentOutlined" />
                    <p>
                      当前已开放 Agent 运行闭环。知识库、Skills、AI
                      工作流和嵌入组件将继续接入这套平台。
                    </p>
                  </div>
                </>
              )}
              {page === "agents" &&
                (agents.length ? (
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
                ))}
              {page === "models" && (
                <section className="panel">
                  <Table<Model>
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
                      { title: "模型 ID", dataIndex: "modelId", render: (v) => <code>{v}</code> },
                      { title: "服务地址", dataIndex: "baseUrl", ellipsis: true },
                      {
                        title: "凭据",
                        dataIndex: "hasCredential",
                        render: (v) => (
                          <Tag color={v ? "success" : "default"}>{v ? "已加密保存" : "未设置"}</Tag>
                        ),
                      },
                      { title: "登记时间", dataIndex: "createdAt", render: timestamp },
                    ]}
                  />
                </section>
              )}
              {page === "tools" && (
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
                        render: (v) => (v === "sum" ? "内置求和" : "HTTP GET"),
                      },
                      { title: "能力范围", render: () => <Tag>只读 / 无业务写入</Tag> },
                      { title: "版本", render: () => <code>v1</code> },
                      { title: "登记时间", dataIndex: "createdAt", render: timestamp },
                    ]}
                  />
                </section>
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
                              onFinish={() => void refresh()}
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
              {page === "runs" && (
                <section className="panel">
                  <Table<Run>
                    rowKey="id"
                    dataSource={runs}
                    pagination={{ pageSize: 10 }}
                    locale={{
                      emptyText: (
                        <Blank
                          title="还没有运行记录"
                          description="发布 Agent 并发起一次对话后，可以在这里查看执行情况。"
                        />
                      ),
                    }}
                    columns={[
                      {
                        title: "任务",
                        dataIndex: "id",
                        render: (_, r) => (
                          <Button type="link" onClick={() => void inspectRun(r)}>
                            {r.id.slice(0, 8)}
                          </Button>
                        ),
                      },
                      { title: "Agent", dataIndex: "agentName" },
                      {
                        title: "发布版本",
                        dataIndex: "releaseVersion",
                        render: (v) => <code>v{v}</code>,
                      },
                      {
                        title: "状态",
                        dataIndex: "status",
                        render: (v) => <RunStatus status={v} />,
                      },
                      { title: "Runtime", dataIndex: "runtimeId" },
                      { title: "创建时间", dataIndex: "createdAt", render: timestamp },
                      {
                        title: "操作",
                        render: (_, r) => (
                          <Button type="text" onClick={() => void inspectRun(r)}>
                            查看详情
                          </Button>
                        ),
                      },
                    ]}
                  />
                </section>
              )}
              {page === "applications" && (
                <>
                  <section className="integration-banner">
                    <div className="integration-icon">
                      <CodeOutlined key="CodeOutlined" />
                    </div>
                    <div>
                      <h2>把 Agent 接入业务后端</h2>
                      <p>
                        创建项目范围的 AppID 与 AK/SK，使用生成的 TypeScript SDK
                        调用。凭据仅保存在服务端。
                      </p>
                    </div>
                    <Button
                      href="/openapi.json"
                      target="_blank"
                      icon={<ApiOutlined key="ApiOutlined" />}
                    >
                      OpenAPI 定义
                    </Button>
                  </section>
                  <section className="panel">
                    <Table<Application>
                      rowKey="id"
                      dataSource={applications}
                      pagination={false}
                      locale={{
                        emptyText: (
                          <Blank
                            title="创建应用凭据"
                            description="应用与平台用户的会话默认隔离，应用只能使用当前项目中已发布的 Agent。"
                          />
                        ),
                      }}
                      columns={[
                        { title: "应用名称", dataIndex: "name" },
                        { title: "AppID", dataIndex: "id", render: (v) => <code>{v}</code> },
                        {
                          title: "状态",
                          dataIndex: "active",
                          render: (v) => (
                            <Tag color={v ? "success" : "default"}>{v ? "有效" : "已撤销"}</Tag>
                          ),
                        },
                        {
                          title: "操作",
                          render: (_, a) => (
                            <Button
                              danger
                              type="text"
                              disabled={!a.active}
                              onClick={() =>
                                void unwrap(
                                  api.revokeApplication({
                                    path: { projectId, id: a.id },
                                    body: {},
                                  }),
                                )
                                  .then(() => refresh())
                                  .catch((e) => message.error(e.message))
                              }
                            >
                              撤销凭据
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </section>
                  <section className="code-panel">
                    <div>
                      <strong>生成 SDK 调用示例</strong>
                      <Tag>TypeScript · 服务端</Tag>
                    </div>
                    <pre>{`import { createClient } from '@platform/sdk/client';\nimport { applicationSigner } from '@platform/sdk/auth';\nimport { createConversation, createRun, getRun } from '@platform/sdk';\n\nconst client = createClient({ baseUrl: process.env.PLATFORM_URL });\nclient.interceptors.request.use(applicationSigner({\n  appId: process.env.APP_ID,\n  accessKey: process.env.ACCESS_KEY,\n  secretKey: process.env.SECRET_KEY,\n}));\nconst path = { projectId: '${projectId}' };\nconst { data: conversation } = await createConversation({\n  client, path, body: { agentId: '已发布的 Agent ID' },\n});\nconst { data: run } = await createRun({\n  client, path, body: { conversationId: conversation.id,\n    input: '请处理这项任务', requestId: crypto.randomUUID() },\n});\n// 使用 getRun 查询状态；使用 listRunEvents 读取执行事件。`}</pre>
                  </section>
                </>
              )}
              {page === "runtimes" && (
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
              )}
            </>
          )}
        </main>
      </div>
      <Editor
        kind={editor}
        projectId={projectId}
        models={models}
        tools={tools}
        agent={editingAgent}
        onClose={() => setEditor(null)}
        onSaved={() => {
          if (editor === "project") void refreshProjects(true);
          else void refresh();
        }}
        onCredential={setCredential}
      />
      <Modal
        title="保存应用凭据"
        open={!!credential}
        onCancel={() => setCredential(null)}
        footer={
          <Button type="primary" onClick={() => setCredential(null)}>
            我已保存
          </Button>
        }
        destroyOnHidden
      >
        {credential && (
          <>
            <Alert type="warning" title="SK 只显示这一次。关闭后无法再次查看，请保存在业务后端。" />
            <div className="credential-fields">
              <label htmlFor="app-id">
                AppID
                <Input id="app-id" readOnly value={credential.id} />
              </label>
              <label htmlFor="access-key">
                Access Key
                <Input id="access-key" readOnly value={credential.accessKey} />
              </label>
              <label htmlFor="secret-key">
                Secret Key
                <Input.Password id="secret-key" readOnly value={credential.secretKey} />
              </label>
            </div>
          </>
        )}
      </Modal>
      <Drawer
        title="运行详情"
        open={!!runDetail}
        onClose={() => {
          detailRequest.current++;
          setRunDetail(null);
        }}
        size={640}
      >
        {runDetail && (
          <>
            <div className="run-detail-head">
              <h2>{runDetail.agentName}</h2>
              <RunStatus status={runDetail.status} />
            </div>
            <dl className="detail-grid">
              <dt>运行 ID</dt>
              <dd>
                <code>{runDetail.id}</code>
              </dd>
              <dt>发布版本</dt>
              <dd>v{runDetail.releaseVersion}</dd>
              <dt>Runtime</dt>
              <dd>{runDetail.runtimeId}</dd>
              <dt>开始时间</dt>
              <dd>{timestamp(runDetail.createdAt)}</dd>
            </dl>
            {runDetail.errorCode && (
              <Alert
                type="error"
                title={`运行失败：${runDetail.errorCode}`}
                description="请检查模型连接、服务凭据与 Runtime 状态。"
              />
            )}
            {runDetail.outputText && (
              <section className="run-output">
                <h3>输出</h3>
                <p>{runDetail.outputText}</p>
              </section>
            )}
            <h3>
              执行事件{" "}
              <span className="muted">
                {events.length}
                {eventsMore ? "+" : ""}
              </span>
              <Button
                type="link"
                loading={eventsLoading}
                onClick={() => void inspectRun(runDetail)}
              >
                刷新详情
              </Button>
            </h3>
            {eventsMore && (
              <Button loading={eventsLoading} onClick={() => void inspectRun(runDetail, true)}>
                加载后续事件
              </Button>
            )}
            <div className="event-list">
              {events.map((e) => (
                <details key={e.seq}>
                  <summary>
                    <span>#{e.seq}</span>
                    <strong>{String(e.chunk.type)}</strong>
                    <small>{timestamp(e.createdAt)}</small>
                  </summary>
                  <pre>{JSON.stringify(e.chunk, null, 2)}</pre>
                </details>
              ))}
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
}
