import { RobotOutlined, ToolOutlined, UserOutlined } from "@ant-design/icons";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AssistantRuntimeProvider,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { cancelRun, getConversationCapabilities } from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Alert, Tag } from "antd";
import { useRef, useState } from "react";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { unwrap } from "../../shared/api";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
  ToolFallback,
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "../../shared/assistant-ui";
import { projectKey, useProjectId } from "../../shared/data/ProjectData";
import { projectPath } from "../../shared/navigation";
import { ChatComposer } from "./ChatComposer";

type Citation = { citationId: string; filename: string; ordinal: number; content: string };
function MessageContext({ trace = false }: { trace?: boolean }) {
  const projectId = useProjectId();
  const metadata = useAuiState((s) => s.message.metadata.custom);
  const skills = Array.isArray(metadata?.selectedSkills) ? metadata.selectedSkills : [];
  return (
    <div className="message-context">
      {skills.map((s) =>
        s && typeof s === "object" && "versionId" in s && "name" in s && "version" in s ? (
          <Tag key={String(s.versionId)}>
            {String(s.name)} · v{String(s.version)}
          </Tag>
        ) : null,
      )}
      {trace && typeof metadata?.runId === "string" && (
        <Link to={projectPath(projectId, "runs", metadata.runId)}>查看本次运行轨迹</Link>
      )}
    </div>
  );
}
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
const ToolCard: ToolCallMessagePartComponent = (props) => {
  const { toolName, result } = props;
  if (toolName === "knowledge_search" && result !== undefined && !props.isError) {
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
  return <ToolFallback {...props} />;
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
        <MessageContext />
      </div>
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="chat-message assistant-message assistant-elements">
      <span className="message-avatar">
        <RobotOutlined />
      </span>
      <div className="message-body">
        <small>Assistant</small>
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-reasoning"],
            "tool-call": ["group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            if (part.type === "group-tool")
              return (
                <ToolGroupRoot variant="ghost">
                  <ToolGroupTrigger
                    count={part.indices.length}
                    active={part.status.type === "running"}
                  />
                  <ToolGroupContent>{children}</ToolGroupContent>
                </ToolGroupRoot>
              );
            if (part.type === "group-reasoning")
              return (
                <ReasoningRoot streaming={part.status.type === "running"}>
                  <ReasoningTrigger active={part.status.type === "running"} />
                  <ReasoningContent>
                    <ReasoningText>{children}</ReasoningText>
                  </ReasoningContent>
                </ReasoningRoot>
              );
            if (part.type === "reasoning") return <span>{part.text}</span>;
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
            if (part.type === "tool-call") return part.toolUI ?? <ToolCard {...part} />;
            return null;
          }}
        </MessagePrimitive.GroupedParts>
        <MessageContext trace />
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
  const capabilities = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "capabilities"),
    queryFn: ({ signal }) =>
      unwrap(getConversationCapabilities({ path: { projectId, id: conversationId }, signal })),
    gcTime: 0,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [initialMessages] = useState(() => messages);
  const [error, setError] = useState(""),
    runId = useRef<string | null>(null),
    pendingCancel = useRef(false);
  const runtime = useChatRuntime({
    id: conversationId,
    messages: initialMessages,
    transport: new AssistantChatTransport({
      api: `/api/v1/projects/${projectId}/conversations/${conversationId}/chat`,
      credentials: "include",
      body: () => ({ skillVersionIds: selectedRef.current }),
      fetch: async (input, init) => {
        setError("");
        runId.current = null;
        const response = await fetch(input, init);
        runId.current = response.headers.get("x-platform-run-id");
        if (response.ok) setSelected([]);
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
          <ChatComposer
            skills={capabilities.data?.skills ?? []}
            selected={selected}
            onSelect={setSelected}
            stop={stop}
            loading={capabilities.isPending}
            error={capabilities.isError}
          />
          <p className="chat-footnote">
            模型输出请结合业务事实核对。会话与运行记录保存在当前项目中。
          </p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
