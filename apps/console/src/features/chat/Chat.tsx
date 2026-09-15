import { RobotOutlined } from "@ant-design/icons";
import {
  AssistantChatTransport,
  type UseChatRuntimeOptions,
  useChatRuntime,
} from "@assistant-ui/ai-sdk";
import { AssistantRuntimeProvider, AuiConfig, AuiIf, Tools } from "@assistant-ui/react";
import {
  type Conversation,
  type ConversationContext,
  cancelAssistantRun,
  cancelRun,
  getConversationCapabilities,
  getConversationContext,
  resetConversation,
} from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateUIMessage, UIMessage } from "ai";
import { Alert, Drawer, List } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { unwrap } from "../../shared/api";
import { Thread, type ThreadComponents } from "../../shared/assistant-ui";
import { projectKey, useStorageScope } from "../../shared/data/ProjectData";
import { ArtifactCanvas } from "./ArtifactCanvas";
import { ChatComposer } from "./ChatComposer";
import { ChatEdit, ChatEditContext } from "./ChatEdit";
import { ChatFeedback } from "./ChatFeedback";
import { AssistantContext, MessageContext, MessageExtras, ToolCard } from "./ChatMessage";
import { ChatReasoning, ChatToolGroup } from "./ChatProcess";
import { ChatRecovery } from "./ChatRecovery";
import { chatToolkit, ToolTraceContext } from "./ChatToolCards";
import { ChatTurn } from "./ChatTurn";
import { ChatTurnRail } from "./ChatTurnRail";
import { chatCommands, parseChatCommand } from "./commands";
import {
  type ConversationDraft,
  createRunStorage,
  draftStorageKey,
  readDraft,
  saveDraft,
} from "./continuity";
import { formatRunError } from "./run-status";
import { voiceAdapters } from "./voice";

function Welcome() {
  return (
    <div className="chat-welcome">
      <span className="chat-welcome-icon">
        <RobotOutlined />
      </span>
      <h2>今天，一起完成什么？</h2>
      <p>
        提出问题，或描述你想完成的任务。
        <br />
        输入 / 可以压缩上下文、开启新会话或选择 Skill。
      </p>
    </div>
  );
}
const THREAD_COMPONENTS: ThreadComponents = {
  Welcome,
  EditComposer: ChatEdit,
  AssistantBody: ChatTurn,
  ReasoningGroup: ChatReasoning,
  ToolGroup: ChatToolGroup,
  ToolFallback: ToolCard,
  UserFooter: MessageContext,
  AssistantFooter: AssistantContext,
  AssistantActions: MessageExtras,
};

export function Chat({
  projectId,
  conversationId,
  messages,
  onFinish,
  resumeRun = null,
  onFork,
  onReset,
  onRunningChange,
  assistantMode = false,
  initialPrompt = "",
  components,
  prefill,
}: {
  projectId: string;
  conversationId: string;
  messages: UIMessage[];
  resumeRun?: { id: string; status: string } | null;
  onFinish: () => void;
  onFork?: (id: string) => void;
  onReset?: (conversation: Conversation) => void;
  onRunningChange?: (running: boolean) => void;
  assistantMode?: boolean;
  initialPrompt?: string;
  components?: Partial<ThreadComponents>;
  prefill?: { id: string; text: string };
}) {
  const [compacting, setCompacting] = useState<{ pass: number; passes: number }>();
  const [commandPanel, setCommandPanel] = useState<"help" | "context" | "skills">();
  const [contextInfo, setContextInfo] = useState<ConversationContext>();
  const [commandBusy, setCommandBusy] = useState(false);
  const commandPending = useRef(false);
  const resetRequest = useRef(uuid());
  const config = AuiConfig({ tools: Tools({ toolkit: chatToolkit }) });
  const capabilities = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "capabilities"),
    queryFn: ({ signal }) =>
      unwrap(getConversationCapabilities({ path: { projectId, id: conversationId }, signal })),
    gcTime: 0,
    staleTime: 0,
  });
  const client = useQueryClient();
  const scope = useStorageScope(),
    storageKey = draftStorageKey(scope, conversationId);
  const [resumable] = useState(() => createRunStorage(resumeRun?.id ?? null));
  const [disconnected, setDisconnected] = useState(false);
  const [recovering, setRecovering] = useState(!!resumeRun);
  const draftKey = useMemo(
    () => projectKey(projectId, "conversations", conversationId, "draft"),
    [projectId, conversationId],
  );
  const [draft] = useState(
    () =>
      client.getQueryData<ConversationDraft>(draftKey) ??
      readDraft(storageKey) ?? { text: initialPrompt, skills: [] },
  );
  const [selected, setSelected] = useState(draft.skills);
  const [cancelling, setCancelling] = useState(false);
  const [feedbackRun, setFeedbackRun] = useState(resumeRun?.id ?? "");
  const selectSkills = (skills: string[]) => {
    selectedRef.current = skills;
    setSelected(skills);
    const next = {
      text: client.getQueryData<ConversationDraft>(draftKey)?.text ?? draft.text,
      skills,
    };
    client.setQueryData(draftKey, next);
    saveDraft(storageKey, next);
  };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [initialMessages] = useState(() => messages);
  const [error, setError] = useState(""),
    runId = useRef<string | null>(resumeRun?.id ?? null),
    pendingCancel = useRef(false),
    transportFailed = useRef(false),
    cancelled = useRef(false);
  const runtime = useChatRuntime({
    id: conversationId,
    messages: initialMessages,
    adapters: voiceAdapters,
    isSendDisabled:
      disconnected ||
      recovering ||
      (selected.length > 0 &&
        (capabilities.isPending ||
          capabilities.isError ||
          selected.some(
            (id) =>
              !capabilities.data?.skills.some((skill) => skill.versionId === id && skill.enabled),
          ))),
    // The live user message must retain the same explicit selection as restored
    // server history. It describes user intent; actual use comes from tool results.
    toCreateMessage: <T extends UIMessage>(
      message: Parameters<NonNullable<UseChatRuntimeOptions["toCreateMessage"]>>[0],
    ) => {
      const parts = message.content.map((part) => {
        if (part.type !== "text") throw new Error("当前仅支持文本消息");
        return { type: "text" as const, text: part.text };
      });
      const selectedSkills = (capabilities.data?.skills ?? [])
        .filter((skill) => selectedRef.current.includes(skill.versionId))
        .map(({ versionId, name, version }) => ({ versionId, name, version }));
      return {
        role: message.role,
        parts,
        metadata: { ...message.metadata, selectedSkills },
      } as CreateUIMessage<T>;
    },
    transport: new AssistantChatTransport({
      api: `/api/v1/projects/${projectId}/${assistantMode ? "assistant/" : ""}conversations/${conversationId}/chat`,
      credentials: "include",
      resumable: {
        storage: resumable,
        resumeApi: (id) =>
          `/api/v1/projects/${projectId}/conversations/${conversationId}/stream?runId=${encodeURIComponent(id)}`,
      },
      body: () => ({ skillVersionIds: selectedRef.current }),
      // The server owns stored history and reads only the newest user message;
      // shipping the whole thread overflows the 256KB request body limit.
      prepareSendMessagesRequest: async ({ messages }) => ({
        body: { messages: messages.slice(-1), skillVersionIds: selectedRef.current },
      }),
      fetch: async (input, init) => {
        const sending = init?.method === "POST";
        transportFailed.current = false;
        setError("");
        if (sending) runId.current = null;
        cancelled.current = false;
        let response: Response;
        try {
          response = await fetch(input, init);
        } catch (error) {
          transportFailed.current = true;
          setDisconnected(true);
          throw error;
        }
        runId.current = response.headers.get("x-platform-run-id") ?? runId.current;
        setFeedbackRun(runId.current ?? "");
        if (response.ok) {
          setRecovering(false);
          if (sending) setDisconnected(false);
          if (sending) selectSkills([]);
        }
        if (pendingCancel.current) await cancelPlatformRun();
        return response;
      },
    }),
    onData: (part) => {
      if (
        part.type === "data-context-compaction" &&
        part.data &&
        typeof part.data === "object" &&
        "pass" in part.data &&
        "passes" in part.data
      )
        setCompacting({ pass: Number(part.data.pass), passes: Number(part.data.passes) });
    },
    onError: (error) => {
      setCompacting(undefined);
      pendingCancel.current = false;
      setCancelling(false);
      // Cancelling aborts the stream, and that abort arrives here. It is an
      // intentional action, not a failure of the run, so it is not reported.
      if (cancelled.current) return;
      setError(formatRunError(error.message));
      if (resumable.getStreamId(conversationId)) setDisconnected(true);
    },
    onFinish: ({ isDisconnect }) => {
      setCompacting(undefined);
      if (
        !cancelled.current &&
        (isDisconnect || transportFailed.current || resumable.getStreamId(conversationId))
      ) {
        setDisconnected(true);
        return;
      }
      setRecovering(false);
      setDisconnected(false);
      resumable.clear(conversationId);
      pendingCancel.current = false;
      setCancelling(false);
      onFinish();
    },
  });
  useEffect(() => {
    const update = () => onRunningChange?.(runtime.thread.getState().isRunning);
    update();
    return runtime.thread.subscribe(update);
  }, [runtime, onRunningChange]);
  // assistant-ui owns the live composer; only its unsent draft is stored per account and tab.
  useEffect(() => {
    client.setQueryDefaults(draftKey, { gcTime: Infinity });
    const composer = runtime.thread.composer;
    composer.setText(draft.text);
    return composer.subscribe(() => {
      const next = { skills: selectedRef.current, text: composer.getState().text };
      client.setQueryData(draftKey, next);
      saveDraft(storageKey, next);
    });
  }, [client, draftKey, draft, runtime, storageKey]);
  const appliedPrefill = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prefill || appliedPrefill.current === prefill.id) return;
    appliedPrefill.current = prefill.id;
    const current = runtime.thread.composer.getState().text.trim();
    runtime.thread.composer.setText([current, prefill.text].filter(Boolean).join("\n"));
  }, [prefill, runtime]);
  /**
   * Cancels the run itself. The composer's own cancel stops reading the stream,
   * but the server only stops *streaming* when the client disconnects — the run
   * keeps working until it is cancelled through the API.
   */
  async function cancelPlatformRun() {
    setCancelling(true);
    if (!runId.current) {
      // The id arrives with the response headers, so a cancel that lands before
      // them is honoured by the fetch wrapper above.
      pendingCancel.current = true;
      return;
    }
    pendingCancel.current = false;
    try {
      await unwrap(
        (assistantMode ? cancelAssistantRun : cancelRun)({
          path: { projectId, id: runId.current },
          body: {},
        }),
      );
      cancelled.current = true;
      resumable.clear(conversationId);
      setDisconnected(false);
      setRecovering(false);
      runtime.thread.cancelRun();
      onFinish();
    } catch (e) {
      setError(e instanceof Error ? e.message : "取消失败");
    } finally {
      setCancelling(false);
    }
  }
  function command(text: string) {
    const parsed = parseChatCommand(text);
    if (!parsed) return false;
    if (commandPending.current) return true;
    const perform = async () => {
      if (parsed.argument && parsed.name !== "compact")
        throw new Error(`/${parsed.name} 不接受参数。输入 /help 查看用法。`);
      if (
        ["clear", "compact"].includes(parsed.name) &&
        (runtime.thread.getState().isRunning || recovering || disconnected)
      )
        throw new Error("请先停止或恢复当前任务，再执行这个指令。");
      if (parsed.name === "clear") {
        if (!onReset && !onFork) throw new Error("请在会话工作区新建对话。");
        const next = await unwrap(
          resetConversation({
            path: { projectId, id: conversationId },
            body: { requestId: resetRequest.current },
          }),
        );
        runtime.thread.composer.setText("");
        selectSkills([]);
        onFinish();
        if (onReset) onReset(next);
        else onFork?.(next.id);
      } else if (parsed.name === "compact") {
        setCompacting({ pass: 0, passes: 0 });
        runtime.thread.composer.setText("");
        runtime.thread.append({
          role: "user",
          content: [
            { type: "text", text: `/compact${parsed.argument ? ` ${parsed.argument}` : ""}` },
          ],
        });
      } else if (parsed.name === "stop") {
        await cancelPlatformRun();
        runtime.thread.composer.setText("");
      } else {
        setCommandPanel(parsed.name);
        if (parsed.name === "context") {
          setContextInfo(undefined);
          setContextInfo(
            await unwrap(getConversationContext({ path: { projectId, id: conversationId } })),
          );
        }
        runtime.thread.composer.setText("");
      }
    };
    commandPending.current = true;
    setCommandBusy(true);
    void perform()
      .catch((e) => setError(e instanceof Error ? e.message : "指令执行失败"))
      .finally(() => {
        commandPending.current = false;
        setCommandBusy(false);
      });
    return true;
  }
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <Drawer
        open={!!commandPanel}
        onClose={() => setCommandPanel(undefined)}
        title={
          commandPanel === "context"
            ? "模型上下文"
            : commandPanel === "skills"
              ? "会话 Skills"
              : "对话指令"
        }
        loading={commandBusy}
      >
        {commandPanel === "help" && (
          <>
            <List
              dataSource={[...chatCommands]}
              renderItem={(c) => (
                <List.Item>
                  <List.Item.Meta title={`/${c.name}`} description={c.description} />
                </List.Item>
              )}
            />
            <p>
              /new 等同 /clear；/compact 后可补充需要重点保留的内容。/skill
              名称可选择与系统指令同名的 Skill。清空和压缩均保留原始会话记录。
            </p>
          </>
        )}
        {commandPanel === "context" && contextInfo && (
          <>
            <p>
              原始消息 {contextInfo.totalMessages} 条 · 摘要覆盖 {contextInfo.coveredMessages} 条
            </p>
            <p>
              {contextInfo.createdAt
                ? `最近压缩：${new Date(contextInfo.createdAt).toLocaleString()}`
                : "尚未手动压缩。长任务可能触发模型上下文自动裁剪。"}
            </p>
            <p>摘要只替换后续模型请求中的历史；首条原始目标仍单独保留。原文和轨迹可继续追溯。</p>
            {contextInfo.summary && (
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {contextInfo.summary}
              </pre>
            )}
          </>
        )}
        {commandPanel === "skills" && (
          <List
            locale={{ emptyText: "此会话没有绑定项目 Skill；平台助手的内置指导请查看“我的能力”。" }}
            dataSource={capabilities.data?.skills ?? []}
            renderItem={(s) => (
              <List.Item>
                <List.Item.Meta
                  title={`${s.name} · v${s.version}${s.enabled ? "" : " · 已停用"}`}
                  description={s.description}
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
      <ToolTraceContext.Provider value={{ projectId, conversationId, assistantMode }}>
        <ChatEditContext.Provider
          value={{
            projectId,
            conversationId,
            disabled: assistantMode || recovering || disconnected || cancelling,
            onFork,
          }}
        >
          <ArtifactCanvas key={`${projectId}/${conversationId}`} projectId={projectId}>
            <Thread
              maxWidth="68rem"
              components={{ ...THREAD_COMPONENTS, ...components }}
              composer={
                <>
                  <ChatRecovery
                    projectId={projectId}
                    conversationId={conversationId}
                    disconnected={disconnected}
                    storage={resumable}
                    onRun={(id) => {
                      runId.current = id;
                    }}
                    onRecovered={() => {
                      setDisconnected(false);
                      setRecovering(false);
                      setError("");
                      onFinish();
                    }}
                  />
                  {error && !disconnected && (
                    <Alert type="error" title={error} closable={{ onClose: () => setError("") }} />
                  )}
                  {!!feedbackRun && !assistantMode && (
                    <AuiIf condition={(s) => s.thread.isRunning}>
                      <ChatFeedback
                        key={feedbackRun}
                        projectId={projectId}
                        runId={feedbackRun}
                        disabled={cancelling || disconnected || recovering}
                      />
                    </AuiIf>
                  )}
                  {compacting && (
                    <Alert
                      type="info"
                      showIcon
                      title={
                        compacting.passes
                          ? `正在压缩上下文 · 第 ${compacting.pass} / ${compacting.passes} 部分`
                          : "正在准备上下文摘要"
                      }
                      description="摘要完成后用于后续对话，原始记录和轨迹继续保留。"
                    />
                  )}
                  <ChatComposer
                    onCommand={command}
                    skills={capabilities.data?.skills ?? []}
                    selected={selected}
                    onSelect={selectSkills}
                    cancelRun={() => void cancelPlatformRun()}
                    cancelling={cancelling}
                    recovering={recovering || (disconnected && !!runId.current)}
                    loading={capabilities.isPending}
                    error={capabilities.isError}
                    onRetry={() => void capabilities.refetch()}
                  />
                </>
              }
              footer={<p className="chat-footnote">内容由 AI 生成，请结合业务事实核对</p>}
            />
            <ChatTurnRail />
          </ArtifactCanvas>
        </ChatEditContext.Provider>
      </ToolTraceContext.Provider>
    </AssistantRuntimeProvider>
  );
}
