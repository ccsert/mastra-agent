import { CommentOutlined, PlusOutlined } from "@ant-design/icons";
import type { Conversation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { Button, Spin, Tag } from "antd";
import { lazy, Suspense } from "react";
import { timestamp, unwrap } from "./api";
import { Blank } from "./Blank";
import { projectKey, useProjectId, useProjectQuery, useProjectRefresh } from "./data/ProjectData";
import { QueryState } from "./data/QueryState";

const Chat = lazy(() => import("./Chat").then((module) => ({ default: module.Chat })));
export function ChatWorkspace({
  conversation,
  onSelect,
  onCreate,
}: {
  conversation: Conversation | null;
  onSelect(item: Conversation): void;
  onCreate(): void;
}) {
  const query = useProjectQuery("conversations"),
    conversations = query.data ?? [];
  return (
    <section className="chat-workspace">
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
                onClick={() => onSelect(c)}
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
            <ConversationSession key={conversation.id} conversationId={conversation.id} />
          </>
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
