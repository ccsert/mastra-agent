import {
  AimOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  CodeSandboxOutlined,
  HistoryOutlined,
  PlusOutlined,
  SafetyOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { AssistantSession, Principal } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { Alert, Button, Modal, Select, Spin } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { unwrap } from "../../shared/api";
import { useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { AssistantCapabilityDrawer } from "../capabilities/index";
import { loadChat } from "../chat/index";
import { ApplicationCollaboration } from "./ApplicationCollaboration";
import { AssistantNavigation, AssistantToolCard } from "./AssistantToolCard";
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
const suggestions = [
  {
    title: "搭建一个业务助手",
    detail: "从目标出发，组合模型、知识和工具",
    prompt:
      "帮我创建一个企业制度问答助手。先检查当前可用模型和知识库，按最小工具权限给出可审阅的草稿方案。",
  },
  {
    title: "把流程变成自动化",
    detail: "让步骤、判断和结果清晰可见",
    prompt:
      "我想把一个业务流程做成工作流。请先解释平台支持的流程能力，帮助我明确必要信息，再准备草稿。",
  },
  {
    title: "整理团队知识与 Skills",
    detail: "复用现有能力，补齐缺少的部分",
    prompt:
      "帮我检查当前项目的知识库和 Skills，告诉我现状以及哪些内容需要补齐。先只读取，不做变更。",
  },
  {
    title: "解释当前页面",
    detail: "了解用途、权限和下一步",
    prompt: "请解释任务开始时所在页面的用途、我当前有哪些权限，以及可以从哪里开始。",
  },
];
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
}: {
  projectId: string;
  projectName: string;
  user: Principal;
  context: AssistantContext;
  onNavigate(page: string, id?: string, targetProjectId?: string): void;
}) {
  const [open, setOpen] = useState(false),
    [session, setSession] = useState<AssistantSession>(),
    [prompt, setPrompt] = useState(""),
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
  const [appVisible, setAppVisible] = useState(false);
  const bootstrap = useQuery({
    queryKey: assistantKey(projectId),
    queryFn: ({ signal }) => unwrap(api.getPlatformAssistant({ path: { projectId }, signal })),
    enabled: open,
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const pageIdentity = `${context.page}/${context.resourceId ?? ""}`;
  const previousPage = useRef(pageIdentity);
  useEffect(() => {
    if (previousPage.current !== pageIdentity) {
      previousPage.current = pageIdentity;
      setOpen(false);
    }
  }, [pageIdentity]);
  const finish = () => {
    void proposals.refetch();
    void bootstrap.refetch();
  };
  async function start(text = "") {
    if (busy) return;
    const signature = JSON.stringify({ context, text });
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
            ...(text.trim() ? { message: text.trim() } : {}),
          },
        }),
      );
      startRequest.current = undefined;
      setPrompt("");
      setSession(next);
      setPrefill(undefined);
      setHistory(false);
      void bootstrap.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开启任务");
    } finally {
      setBusy(false);
    }
  }
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
    setOpen(false);
    onNavigate(page, id, targetProjectId);
  };
  return (
    <>
      <Button
        className={`platform-assistant-trigger${running ? " is-running" : ""}`}
        icon={<ThunderboltOutlined />}
        onClick={() => setOpen(true)}
        aria-label="打开平台助手"
      >
        平台助手 <kbd>⇧⌘K</kbd>
        {running && <span className="assistant-live-dot" />}
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width="var(--assistant-width)"
        className={`platform-assistant-modal${appVisible ? " with-app" : ""}`}
        focusable={{ trap: !appVisible }}
        centered
        closable={false}
        styles={{ body: { padding: 0 } }}
        destroyOnHidden={false}
      >
        <section className="assistant-taskdesk" aria-label="平台助手任务台">
          <header className="assistant-desk-header">
            <div className="assistant-identity">
              <span className="assistant-orbit">
                <CodeSandboxOutlined />
              </span>
              <div>
                <h2>
                  平台助手 <span>任务台</span>
                </h2>
                <p>
                  {projectName} <span> / </span> {user.displayName}
                </p>
              </div>
            </div>
            <div className="assistant-desk-actions">
              <Button
                type="text"
                icon={<SafetyOutlined />}
                aria-label="我的能力"
                onClick={() => setCapabilitiesOpen(true)}
              >
                我的能力
              </Button>
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
                onClick={() => setHistory((v) => !v)}
              />
              <Button
                type="text"
                icon={<PlusOutlined />}
                disabled={!bootstrap.data?.configuration || busy || running}
                onClick={() => void start()}
              >
                新任务
              </Button>
              <Button
                type="text"
                icon={<CloseOutlined />}
                aria-label="收起平台助手"
                onClick={() => setOpen(false)}
              />
            </div>
          </header>
          <div className="assistant-context-strip">
            <span>
              <AimOutlined /> {session ? "任务起始页面" : "当前页面"} ·{" "}
              {pageLabels[session?.context.page ?? context.page ?? "overview"]}
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
              onReveal={() => setOpen(false)}
              onWorkspace={setAppVisible}
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
                    setPrompt("");
                    setPrefill(undefined);
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
            <div className="assistant-launch">
              <div className="assistant-launch-copy">
                <span className="assistant-eyebrow">从想法，到可用的能力</span>
                <h2>
                  想让这个平台
                  <br />
                  替你完成什么？
                </h2>
                <p>
                  说出目标。我来查找现有资源、组合能力，
                  <br />
                  把需要你决定的更改放到眼前。
                </p>
                <div className="assistant-intent">
                  <textarea
                    aria-label="平台助手任务目标"
                    placeholder="例如：用现有知识库搭建一个制度问答助手…"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void start(prompt);
                      }
                    }}
                  />
                  <Button
                    type="primary"
                    icon={<ArrowRightOutlined />}
                    disabled={!prompt.trim()}
                    loading={busy}
                    onClick={() => void start(prompt)}
                  >
                    开始构建
                  </Button>
                </div>
              </div>
              <div className="assistant-starters">
                {suggestions.map((s, i) => (
                  <button
                    type="button"
                    key={s.title}
                    disabled={busy}
                    onClick={() => void start(s.prompt)}
                  >
                    <span className="assistant-starter-number">0{i + 1}</span>
                    <div>
                      <strong>{s.title}</strong>
                      <p>{s.detail}</p>
                    </div>
                    <ArrowRightOutlined />
                  </button>
                ))}
                <button
                  type="button"
                  className="assistant-launch-note"
                  onClick={() => setCapabilitiesOpen(true)}
                >
                  {bootstrap.data.operations.length} 项当前可用操作 · {bootstrap.data.skills.length}{" "}
                  个内置指导包 · 查看能力
                </button>
              </div>
            </div>
          ) : (
            <div className="assistant-work-area">
              <div className="assistant-conversation">
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
                          setPrompt("");
                          void bootstrap.refetch();
                        }}
                        assistantMode
                        initialPrompt={prompt}
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
              <aside className="assistant-change-pane">
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
      </Modal>
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
