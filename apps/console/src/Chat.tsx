import {
  ArrowUpOutlined,
  BorderOutlined,
  RobotOutlined,
  ToolOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { cancelRun } from "@platform/sdk";
import type { UIMessage } from "ai";
import { Alert } from "antd";
import { useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { unwrap } from "./api";

type Citation = { citationId: string; filename: string; ordinal: number; content: string };
function citations(value: unknown): Citation[] {
  if (!value || typeof value !== "object" || !("sources" in value) || !Array.isArray(value.sources))
    return [];
  return value.sources.filter(
    (s): s is Citation =>
      s &&
      typeof s === "object" &&
      typeof s.citationId === "string" &&
      typeof s.filename === "string" &&
      typeof s.ordinal === "number" &&
      typeof s.content === "string",
  );
}
const ToolCard: ToolCallMessagePartComponent = ({ toolName, args, result }) => {
  if (toolName === "knowledge_search" && result !== undefined) {
    const sources = citations(result);
    return (
      <section className="chat-citations" aria-label="知识库来源">
        <strong>
          <ToolOutlined /> 知识检索 · {sources.length} 个来源
        </strong>
        {sources.length ? (
          sources.map((s) => (
            <details key={s.citationId} className="chat-citation">
              <summary>
                <span>
                  {s.filename} · 片段 {s.ordinal + 1}
                </span>
                <small>[{s.citationId}]</small>
              </summary>
              <p>{s.content}</p>
            </details>
          ))
        ) : (
          <p>未获得可用资料，请查看工具状态或调整问题。</p>
        )}
      </section>
    );
  }
  return (
    <details className="tool-result" open>
      <summary>
        <ToolOutlined /> {toolName} <span>{result === undefined ? "执行中" : "已返回"}</span>
      </summary>
      <div>
        <small>输入</small>
        <pre>{JSON.stringify(args, null, 2)}</pre>
        {result !== undefined && (
          <>
            <small>结果</small>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </>
        )}
      </div>
    </details>
  );
};
function UserMessage() {
  return (
    <MessagePrimitive.Root className="chat-message user-message">
      <span className="message-avatar">
        <UserOutlined />
      </span>
      <div className="message-body">
        <small>你</small>
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="chat-message assistant-message">
      <span className="message-avatar">
        <RobotOutlined />
      </span>
      <div className="message-body">
        <small>Assistant</small>
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text")
              return (
                <MarkdownTextPrimitive
                  className="chat-markdown"
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    img: ({ alt }) => <span>{alt}</span>,
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                />
              );
            if (part.type === "tool-call") return <ToolCard {...part} />;
            return null;
          }}
        </MessagePrimitive.Parts>
        <MessagePrimitive.Error>
          <p className="chat-error">本次运行未完成，请查看错误提示和运行记录。</p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}
export function Chat({
  projectId,
  conversationId,
  messages,
  onFinish,
}: {
  projectId: string;
  conversationId: string;
  messages: UIMessage[];
  onFinish: () => void;
}) {
  const [error, setError] = useState(""),
    runId = useRef<string | null>(null),
    pendingCancel = useRef(false);
  const runtime = useChatRuntime({
    id: conversationId,
    messages,
    transport: new AssistantChatTransport({
      api: `/api/v1/projects/${projectId}/conversations/${conversationId}/chat`,
      credentials: "include",
      fetch: async (input, init) => {
        setError("");
        runId.current = null;
        const response = await fetch(input, init);
        runId.current = response.headers.get("x-platform-run-id");
        if (pendingCancel.current) await stop();
        return response;
      },
    }),
    onError: (error) => {
      pendingCancel.current = false;
      setError(error.message);
    },
    onFinish: () => {
      pendingCancel.current = false;
      onFinish();
    },
  });
  async function stop() {
    pendingCancel.current = true;
    if (runId.current)
      try {
        await unwrap(cancelRun({ path: { projectId, id: runId.current }, body: {} }));
        onFinish();
      } catch (e) {
        setError(e instanceof Error ? e.message : "取消失败");
      }
  }
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          <ThreadPrimitive.Empty>
            <div className="chat-welcome">
              <span>
                <RobotOutlined />
              </span>
              <h2>开始一段有用的对话</h2>
              <p>Agent 将使用此会话绑定的发布版本，以及已配置的模型和工具。</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="composer-area">
          {error && <Alert type="error" title={error} closable={{ onClose: () => setError("") }} />}
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              aria-label="消息"
              placeholder="描述你的任务…"
              className="composer-input"
              rows={2}
            />
            <div className="composer-footer">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <AuiIf condition={(state) => !state.thread.isRunning}>
                <ComposerPrimitive.Send className="send-button" aria-label="发送消息">
                  <ArrowUpOutlined />
                </ComposerPrimitive.Send>
              </AuiIf>
              <AuiIf condition={(state) => state.thread.isRunning}>
                <button
                  type="button"
                  className="send-button cancel-button"
                  aria-label="停止生成"
                  onClick={() => void stop()}
                >
                  <BorderOutlined />
                </button>
              </AuiIf>
            </div>
          </ComposerPrimitive.Root>
          <p className="chat-footnote">
            模型输出请结合业务事实核对。会话与运行记录保存在当前项目中。
          </p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
