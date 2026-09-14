import {
  AimOutlined,
  CloseOutlined,
  CodeSandboxOutlined,
  CompressOutlined,
  ExpandOutlined,
  HistoryOutlined,
  PlusOutlined,
  SafetyOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { AssistantSession, Principal } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { Alert, Button, Select, Spin, Splitter } from "antd";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { AssistantDockContext } from "../../shared/AssistantDock";
import { unwrap } from "../../shared/api";
import { useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { readSessionValue, writeSessionValue } from "../../shared/data/session-storage";
import { AssistantCapabilityDrawer } from "../capabilities/index";
import { loadChat } from "../chat/index";
import { ApplicationCollaboration } from "./ApplicationCollaboration";
import { AssistantNavigation, AssistantToolCard } from "./AssistantToolCard";
import { PageOperationFeedback } from "./PageOperationFeedback";
import { ProposalCard } from "./ProposalCard";

const Chat = lazy(() => loadChat().then((m) => ({ default: m.Chat })));

type AssistantContext = AssistantSession["context"];
const assistantKey = (projectId: string, ...ids: string[]) =>
  ["project", projectId, "platformAssistant", ...ids] as const;
const pageLabels: Record<string, string> = {
  overview: "项目概览",
  agents: "Agent",
  skills: "Skills",
  chat: "对话",
  knowledge: "知识库",
  workflows: "工作流",
  models: "模型服务",
  tools: "工具",
  mcp: "MCP 服务",
  runs: "运行记录",
  applications: "应用",
  runtimes: "运行节点",
  settings: "项目设置",
  team: "团队设置",
};
function Welcome() {
  return (
    <div className="assistant-chat-welcome">
      <span>一起把目标变成可用的能力</span>
      <p>我会先了解现状，再把具体更改放进任务清单。</p>
    </div>
  );
}
const components = { Welcome, ToolFallback: AssistantToolCard };
export function PlatformAssistant({
  projectId,
  projectName,
  user,
  context,
  onNavigate,
  children,
  renderHeader,
  available = true,
}: {
  children?: ReactNode;
  renderHeader?(trigger: ReactNode): ReactNode;
  available?: boolean;
  projectId: string;
  projectName: string;
  user: Principal;
  context: AssistantContext;
  onNavigate(page: string, id?: string, targetProjectId?: string): void;
}) {
  const [open, setOpen] = useState(false),
    [session, setSession] = useState<AssistantSession>(),
    [prefill, setPrefill] = useState<{ id: string; text: string }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(""),
    [running, setRunning] = useState(false),
    [history, setHistory] = useState(false),
    [capabilitiesOpen, setCapabilitiesOpen] = useState(false),
    [configuring, setConfiguring] = useState(false),
    [modelId, setModelId] = useState<string>();
  const refresh = useProjectRefresh();
  const startRequest = useRef<{ signature: string; id: string } | undefined>(undefined);
  const startInFlight = useRef(false);
  const autoStartAttempted = useRef(false);
  const [appVisible, setAppVisible] = useState(false);
  const [appHost, setAppHost] = useState<HTMLDivElement | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const widthKey = `assistant-dock:${user.tenantId}:${user.id}:${projectId}`;
  const [width, setWidth] = useState(() => {
    const saved = readSessionValue(widthKey);
    return typeof saved === "number" && Number.isFinite(saved) && saved >= 340
      ? Math.min(saved, 1000)
      : 420;
  });
  const [collaboration, setCollaboration] = useState<{
    active: boolean;
    acting: boolean;
    title: string;
    stop(): void;
  }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deskRef = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEffect(() => {
    if (open) deskRef.current?.focus({ preventScroll: true });
  }, [open]);
  const bootstrap = useQuery({
    queryKey: assistantKey(projectId),
    queryFn: ({ signal }) => unwrap(api.getPlatformAssistant({ path: { projectId }, signal })),
    enabled: available && open,
    staleTime: 0,
  });
  const models = useProjectQuery("models", {
    enabled:
      open && !!bootstrap.data?.canConfigure && (configuring || !bootstrap.data?.configuration),
  });
  const proposals = useQuery({
    queryKey: assistantKey(projectId, session?.id ?? "none", "proposals"),
    queryFn: ({ signal }) =>
      unwrap(api.listAssistantProposals({ path: { projectId, id: session?.id ?? "" }, signal })),
    enabled: open && !!session,
    refetchInterval: open ? 2000 : false,
    gcTime: 0,
  });
  const saved = useQuery({
    queryKey: assistantKey(projectId, session?.id ?? "none", "session"),
    queryFn: async ({ signal }) => {
      const restored = await unwrap(
        api.getConversationSession({ path: { projectId, id: session?.id ?? "" }, signal }),
      );
      return {
        ...restored,
        messages: restored.messages.length
          ? await validateUIMessages({ messages: restored.messages })
          : [],
      };
    },
    enabled: !!session,
    gcTime: 0,
    staleTime: Infinity,
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        available &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [available]);
  const finish = () => {
    void proposals.refetch();
    void bootstrap.refetch();
  };
  const start = useCallback(async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    const signature = JSON.stringify({ context });
    if (startRequest.current?.signature !== signature)
      startRequest.current = { signature, id: uuid() };
    setBusy(true);
    setError("");
    try {
      const next = await unwrap(
        api.startPlatformAssistant({
          path: { projectId },
          body: {
            requestId: startRequest.current.id,
            context,
          },
        }),
      );
      startRequest.current = undefined;
      setSession(next);
      setChangesOpen(false);
      setPrefill(undefined);
      setHistory(false);
      void bootstrap.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开启任务");
    } finally {
      startInFlight.current = false;
      setBusy(false);
    }
  }, [context, projectId, bootstrap.refetch]);
  useEffect(() => {
    if (
      available &&
      open &&
      bootstrap.data?.configuration &&
      !session &&
      !busy &&
      !configuring &&
      !history &&
      !autoStartAttempted.current
    ) {
      autoStartAttempted.current = true;
      void start();
    }
  }, [available, open, bootstrap.data?.configuration, session, busy, configuring, history, start]);
  async function configure() {
    if (!modelId) return;
    setBusy(true);
    setError("");
    try {
      await unwrap(api.configurePlatformAssistant({ path: { projectId }, body: { modelId } }));
      await bootstrap.refetch();
      setConfiguring(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "配置失败");
    } finally {
      setBusy(false);
    }
  }
  async function apply(id: string, dismiss: boolean) {
    if (!session) return;
    setApplying(id);
    setError("");
    try {
      await unwrap(
        api.applyAssistantProposal({
          path: { projectId, id: session.id, proposalId: id },
          body: { dismiss },
        }),
      );
      await proposals.refetch();
      await refresh();
      setPrefill({
        id: uuid(),
        text: dismiss
          ? "我已放弃刚才的方案，请根据我的新要求调整。"
          : "我已应用任务清单中的变更，请先读取 proposals 核对实际结果，再继续。",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "应用失败");
    } finally {
      setApplying("");
    }
  }
  const navigate = (page: string, id?: string, targetProjectId?: string) => {
    onNavigate(page, id, targetProjectId);
  };
  const trigger = available ? (
    <div className="assistant-toolbar-presence">
      {collaboration?.active && (
        <div className="assistant-toolbar-status">
          <span role="status">{collaboration.acting ? collaboration.title : "页面协作已连接"}</span>
          <Button
            size="small"
            icon={<StopOutlined />}
            onClick={collaboration.stop}
            aria-label="停止页面操作"
          >
            停止页面操作
          </Button>
        </div>
      )}
      <Button
        ref={triggerRef}
        className={`platform-assistant-trigger${running ? " is-running" : ""}`}
        icon={<ThunderboltOutlined />}
        onClick={() => setOpen((value) => !value)}
        aria-label="打开平台助手"
        aria-expanded={open}
        aria-controls="platform-assistant-desk"
      >
        平台助手 <kbd>⇧⌘K</kbd>
        {running && <span className="assistant-live-dot" />}
      </Button>
    </div>
  ) : null;
  const desk = (
    <section
      ref={deskRef}
      id="platform-assistant-desk"
      tabIndex={-1}
      className="assistant-taskdesk"
      aria-label="平台助手任务台"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.target === event.currentTarget) close();
      }}
    >
      <header className="assistant-desk-header">
        <div className="assistant-identity">
          <span className="assistant-orbit">
            <CodeSandboxOutlined />
          </span>
          <div>
            <h2>
              平台助手 <span>与你一起操作</span>
            </h2>
            <p>
              {projectName} <span> / </span> {user.displayName}
            </p>
          </div>
        </div>
        <div className="assistant-desk-actions">
          <Button
            type="text"
            icon={wide ? <CompressOutlined /> : <ExpandOutlined />}
            aria-label={wide ? "收窄助手" : "展开任务台"}
            onClick={() => setWide((value) => !value)}
          />
          <Button
            type="text"
            icon={<SafetyOutlined />}
            aria-label="我的能力"
            onClick={() => setCapabilitiesOpen(true)}
          />
          {bootstrap.data?.canConfigure && (
            <Button
              type="text"
              icon={<SettingOutlined />}
              aria-label="设置助手模型"
              disabled={running || busy}
              onClick={() => {
                setModelId(bootstrap.data?.configuration?.modelId);
                setConfiguring((v) => !v);
              }}
            />
          )}
          <Button
            type="text"
            icon={<HistoryOutlined />}
            aria-label="查看助手任务记录"
            disabled={busy}
            onClick={() => setHistory((v) => !v)}
          />
          <Button
            type="text"
            icon={<PlusOutlined />}
            disabled={!bootstrap.data?.configuration || busy || running}
            onClick={() => void start()}
            aria-label="新任务"
          />
          <Button type="text" icon={<CloseOutlined />} aria-label="收起平台助手" onClick={close} />
        </div>
      </header>
      <div className="assistant-context-strip">
        <span>
          <AimOutlined /> 当前页面 · {pageLabels[context.page ?? "overview"]}
        </span>
        <span>
          <SafetyOutlined /> 继承你的权限 · 按任务使用能力
        </span>
        {running && <span className="assistant-running-label">正在处理 · 可收起任务台</span>}
      </div>
      {session && (
        <ApplicationCollaboration
          key={session.id}
          projectId={projectId}
          conversationId={session.id}
          workspace={appHost}
          onWorkspace={setAppVisible}
          onStatus={setCollaboration}
        />
      )}
      {error && <Alert type="error" title={error} closable={{ onClose: () => setError("") }} />}
      {bootstrap.isError && (
        <Alert
          type="error"
          title="暂时无法读取平台助手"
          action={<Button onClick={() => void bootstrap.refetch()}>重试</Button>}
        />
      )}
      {history && (
        <section className="assistant-history" aria-label="助手任务记录">
          {bootstrap.data?.sessions.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={running}
              className={session?.id === item.id ? "active" : ""}
              onClick={() => {
                setSession(item);
                setChangesOpen(false);
                setPrefill(undefined);
                setChangesOpen(false);
                setHistory(false);
              }}
            >
              <HistoryOutlined />
              <span>{item.title === "新会话" ? "未开始的任务" : item.title}</span>
              <small>{new Date(item.createdAt).toLocaleDateString()}</small>
            </button>
          ))}
          {!bootstrap.data?.sessions.length && <p>任务会保存在这里，随时继续。</p>}
        </section>
      )}
      {bootstrap.isPending ? (
        <div className="assistant-loader">
          <Spin description="读取平台能力…" />
        </div>
      ) : !bootstrap.data?.configuration || configuring ? (
        <div className="assistant-onboarding">
          <span className="assistant-eyebrow">让平台拥有自己的助手</span>
          <h2>先连接一个会思考、能调用工具的模型。</h2>
          <p>模型设置用于新任务，已有任务保留原模型。每位用户使用自己的权限与独立任务记录。</p>
          {bootstrap.data?.canConfigure ? (
            <>
              <Select
                aria-label="平台助手模型"
                placeholder="选择已有对话模型"
                value={modelId}
                onChange={setModelId}
                options={(models.data ?? [])
                  .filter((m) => m.kind === "chat" && m.capabilities?.toolUse !== false)
                  .map((m) => ({ value: m.id, label: m.name }))}
              />
              <Button
                type="primary"
                disabled={!modelId}
                loading={busy}
                onClick={() => void configure()}
              >
                {bootstrap.data?.configuration ? "保存模型设置" : "启用平台助手"}
              </Button>
            </>
          ) : (
            <Alert type="info" title="请项目管理员先选择助手模型" />
          )}
        </div>
      ) : !session ? (
        <div className="assistant-loader">
          {busy ? (
            <Spin description="准备对话…" />
          ) : (
            <Button onClick={() => void start()}>重新打开对话</Button>
          )}
        </div>
      ) : (
        <div className="assistant-work-area">
          <button
            type="button"
            className="assistant-changes-toggle"
            aria-expanded={changesOpen}
            onClick={() => setChangesOpen((value) => !value)}
          >
            <UnorderedListOutlined /> 变更清单 · {proposals.data?.length ?? 0}
            <span>
              {changesOpen
                ? "返回对话"
                : proposals.data?.some((p) => p.status === "pending")
                  ? "有待审阅的更改"
                  : "查看变更"}
            </span>
          </button>
          <div className="assistant-conversation" hidden={changesOpen}>
            <AssistantNavigation.Provider value={navigate}>
              {saved.isError ? (
                <Alert
                  type="error"
                  title="无法恢复任务记录"
                  action={<Button onClick={() => void saved.refetch()}>重试</Button>}
                />
              ) : saved.data ? (
                <Suspense
                  fallback={
                    <div className="assistant-loader">
                      <Spin description="打开对话…" />
                    </div>
                  }
                >
                  <Chat
                    key={session.id}
                    projectId={projectId}
                    conversationId={session.id}
                    messages={saved.data.messages}
                    resumeRun={saved.data.resumeRun}
                    onReset={(next) => {
                      setSession({
                        id: next.id,
                        title: next.title,
                        createdAt: next.createdAt,
                        context,
                      });
                      setPrefill(undefined);
                      setChangesOpen(false);
                      void bootstrap.refetch();
                    }}
                    assistantMode
                    prefill={prefill}
                    components={components}
                    onFinish={finish}
                    onRunningChange={setRunning}
                  />
                </Suspense>
              ) : (
                <div className="assistant-loader">
                  <Spin description="恢复任务…" />
                </div>
              )}
            </AssistantNavigation.Provider>
          </div>
          <aside className="assistant-change-pane" hidden={!changesOpen}>
            <header>
              <span className="assistant-eyebrow">看得见的进展</span>
              <h3>
                任务清单 <span>{proposals.data?.length ?? 0}</span>
              </h3>
              <p>更改先审阅，结果可追溯。</p>
            </header>
            {proposals.isError && (
              <Alert
                type="error"
                title="变更清单读取失败"
                action={<Button onClick={() => void proposals.refetch()}>重试</Button>}
              />
            )}
            <div className="assistant-proposals">
              {proposals.data?.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  busy={!!applying}
                  onApply={(dismiss) => void apply(p.id, dismiss)}
                  onAdjust={() => setPrefill({ id: uuid(), text: `请调整“${p.title}”方案：` })}
                  onNavigate={navigate}
                />
              ))}
              {!proposals.data?.length && (
                <div className="assistant-empty-plan">
                  <NodeSketch />
                  <h4>先理解目标，再组织行动</h4>
                  <p>需要创建或调整的资源会出现在这里。问答和只读查询不会产生待应用更改。</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
  return (
    <>
      {renderHeader ? renderHeader(trigger) : trigger}
      <AssistantDockContext.Provider value={{ open, close }}>
        <Splitter
          className={`assistant-workspace${open ? " is-open" : ""}`}
          onResizeEnd={(sizes) => {
            if (open && !wide && sizes[1]) writeSessionValue(widthKey, sizes[1]);
          }}
          onResize={(sizes) => {
            const size = sizes[1];
            if (size && open && !wide) setWidth(size);
          }}
        >
          <Splitter.Panel min={open ? "30%" : 0} resizable={open}>
            <div className="assistant-page-surface" hidden={appVisible}>
              {children}
            </div>
            <div className="assistant-application-host" ref={setAppHost} hidden={!appVisible} />
          </Splitter.Panel>
          <Splitter.Panel
            size={available && open ? (wide ? "55%" : width) : 0}
            min={open ? 340 : 0}
            max="70%"
            resizable={open}
          >
            {available && desk}
          </Splitter.Panel>
        </Splitter>
      </AssistantDockContext.Provider>
      <PageOperationFeedback />
      {open && capabilitiesOpen && (
        <AssistantCapabilityDrawer
          conversationId={session?.id}
          running={running}
          onClose={() => setCapabilitiesOpen(false)}
          onNavigate={navigate}
        />
      )}
    </>
  );
}
function NodeSketch() {
  return (
    <div className="assistant-node-sketch" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
