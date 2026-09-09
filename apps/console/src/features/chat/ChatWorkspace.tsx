import { CommentOutlined, PlusOutlined } from "@ant-design/icons";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { Button, Spin, Tabs, Tag } from "antd";
import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { timestamp, unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import {
  projectKey,
  useProjectId,
  useProjectPages,
  useProjectRefresh,
} from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import type { ResourceSelection } from "../../shared/navigation";
import { ConversationTrace } from "../runs/index";

const Chat = lazy(() => import("./Chat").then((module) => ({ default: module.Chat })));
export function ChatWorkspace({
  selectedId,
  onSelect,
  onCreate,
}: ResourceSelection & {
  onCreate(): void;
}) {
  const projectId = useProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const tracing = searchParams.get("view") === "trace";
  const detailQuery = useQuery({
    queryKey: projectKey(projectId, "conversations", selectedId ?? "", "detail"),
    queryFn: ({ signal }) =>
      unwrap(api.getConversation({ path: { projectId, id: selectedId ?? "" }, signal })),
    enabled: !!selectedId,
    gcTime: 0,
  });
  const conversation = detailQuery.data;
  const query = useProjectPages("conversations"),
    conversations = pageItems(query.data);
  return (
    <section className={`chat-workspace${tracing ? " tracing" : ""}`}>
      {!tracing && (
        <aside className="conversation-list">
          <div className="conversation-list-head">
            <strong>我的会话</strong>
            <Button type="text" aria-label="新建会话" icon={<PlusOutlined />} onClick={onCreate} />
          </div>
          <QueryState label="会话" query={query}>
            {conversations.length ? (
              conversations.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={
                    conversation?.id === c.id ? "conversation-item selected" : "conversation-item"
                  }
                  onClick={() => onSelect(c.id)}
                >
                  <CommentOutlined />
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
            <div className="conversation-pagination">
              <PageMore query={query} count={conversations.length} label="会话" />
            </div>
          </QueryState>
        </aside>
      )}
      <div className="chat-main">
        {selectedId ? (
          <QueryState label="会话信息" query={detailQuery}>
            {conversation && (
              <>
                <header className="chat-header">
                  <div>
                    <h1>{conversation.title}</h1>
                    <span>会话 {conversation.id.slice(0, 8)}</span>
                  </div>
                  <div>
                    <Tag color="blue">固定版本 v{conversation.releaseVersion}</Tag>
                  </div>
                </header>
                <Tabs
                  className="conversation-view-tabs"
                  activeKey={tracing ? "trace" : "chat"}
                  onChange={(view) => {
                    const next = new URLSearchParams(searchParams);
                    if (view === "trace") next.set("view", view);
                    else {
                      next.delete("view");
                      next.delete("runId");
                    }
                    setSearchParams(next);
                  }}
                  items={[
                    { key: "chat", label: "对话" },
                    { key: "trace", label: "轨迹" },
                  ]}
                />
                <div className="chat-session" hidden={tracing}>
                  <ConversationSession key={conversation.id} conversationId={conversation.id} />
                </div>
                {tracing && (
                  <ConversationTrace
                    key={conversation.id}
                    projectId={projectId}
                    conversationId={conversation.id}
                    focusRunId={searchParams.get("runId") ?? undefined}
                  />
                )}
              </>
            )}
          </QueryState>
        ) : (
          <Blank
            title="选择一个 Agent 开始对话"
            description="会话会固定到创建时的发布版本，历史可以随时回来查看。"
            action={
              <Button type="primary" onClick={onCreate}>
                选择 Agent
              </Button>
            }
          />
        )}
      </div>
    </section>
  );
}
function ConversationSession({ conversationId }: { conversationId: string }) {
  const projectId = useProjectId(),
    refresh = useProjectRefresh();
  const query = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "messages"),
    queryFn: async ({ signal }) => {
      const messages = await unwrap(
        api.listMessages({ path: { projectId, id: conversationId }, signal }),
        signal,
      );
      const validated = messages.length ? await validateUIMessages({ messages }) : [];
      signal.throwIfAborted();
      return validated;
    },
    // Restore server history when opening a conversation; the live chat owns subsequent messages.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return (
    <QueryState label="会话历史" query={query}>
      {query.data && (
        <Suspense
          fallback={
            <div className="chat-loader">
              <Spin />
            </div>
          }
        >
          <Chat
            projectId={projectId}
            conversationId={conversationId}
            messages={query.data}
            onFinish={() => void refresh("runs", "conversations")}
          />
        </Suspense>
      )}
    </QueryState>
  );
}
