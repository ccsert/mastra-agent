import {
  CommentOutlined,
  DeleteOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import * as api from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { App as AntApp, Button, Modal, Popconfirm, Spin, Tabs, Tag } from "antd";
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { timestamp, unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import {
  projectKey,
  useProjectId,
  useProjectPages,
  useProjectQuery,
  useProjectRefresh,
  useStorageScope,
} from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import { writeSessionValue } from "../../shared/data/session-storage";
import type { ResourceSelection } from "../../shared/navigation";
import { ConversationTrace } from "../runs/index";
import { draftStorageKey } from "./continuity";

const Chat = lazy(() => import("./Chat").then((module) => ({ default: module.Chat })));
export function ChatWorkspace({
  selectedId,
  onSelect,
  onConfigureAgents,
}: ResourceSelection & {
  onConfigureAgents(): void;
}) {
  const projectId = useProjectId();
  const storageScope = useStorageScope();
  const { message } = AntApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const refresh = useProjectRefresh();
  const client = useQueryClient();
  const [deleting, setDeleting] = useState("");
  const [picking, setPicking] = useState(false);
  const [connecting, setConnecting] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const showList = !selectedId || listOpen;
  const tracing = searchParams.get("view") === "trace";
  const agentsQuery = useProjectQuery("agents", { enabled: picking });
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.publishedReleaseId);
  // A conversation must name a published Agent up front, so the choice happens
  // here instead of sending the user to another page to find one.
  async function startConversation(agentId: string) {
    setConnecting(agentId);
    try {
      const created = await unwrap(
        api.createConversation({ path: { projectId }, body: { agentId } }),
      );
      setPicking(false);
      await refresh("conversations");
      onSelect(created.id);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法开始对话");
    } finally {
      setConnecting("");
    }
  }
  async function removeConversation(id: string) {
    setDeleting(id);
    try {
      await unwrap(api.deleteConversation({ path: { projectId, id }, body: {} }));
      client.removeQueries({
        queryKey: projectKey(projectId, "conversations", id, "draft"),
        exact: true,
      });
      writeSessionValue(draftStorageKey(storageScope, id), undefined);
      void message.success("会话已删除");
      if (selectedId === id) onSelect(undefined);
      await refresh("conversations", "runs");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting("");
    }
  }
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
      {!tracing && showList && (
        <aside className="conversation-list" id="conversation-list" aria-label="会话列表">
          <div className="conversation-list-head">
            <strong>我的会话</strong>
            <Button
              type="text"
              aria-label="新建会话"
              icon={<PlusOutlined />}
              onClick={() => setPicking(true)}
            />
          </div>
          <QueryState label="会话" query={query}>
            {conversations.length ? (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={
                    conversation?.id === c.id ? "conversation-item selected" : "conversation-item"
                  }
                >
                  <button
                    type="button"
                    className="conversation-open"
                    onClick={() => onSelect(c.id)}
                  >
                    <CommentOutlined />
                    <span>
                      <strong>{c.title}</strong>
                      <small>
                        {c.releaseVersion === 0 ? "草稿试用" : `v${c.releaseVersion}`} ·{" "}
                        {timestamp(c.createdAt)}
                      </small>
                    </span>
                  </button>
                  <Popconfirm
                    title="删除此会话？"
                    description="会话、消息和运行记录将一并删除。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => removeConversation(c.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      className="conversation-delete"
                      aria-label={`删除会话 ${c.title}`}
                      loading={deleting === c.id}
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </div>
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
                  {!tracing && (
                    <div className="chat-navigation">
                      <Button
                        type="text"
                        aria-label={showList ? "收起会话列表" : "展开会话列表"}
                        title={showList ? "收起会话列表" : "展开会话列表"}
                        aria-expanded={showList}
                        aria-controls={showList ? "conversation-list" : undefined}
                        icon={showList ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
                        onClick={() => setListOpen(!showList)}
                      />
                      {!showList && (
                        <Button
                          type="text"
                          aria-label="新建会话"
                          title="新建会话"
                          icon={<PlusOutlined />}
                          onClick={() => setPicking(true)}
                        />
                      )}
                    </div>
                  )}
                  <div className="chat-title">
                    <h1>{conversation.title}</h1>
                    <Tag title="此会话使用创建时的 Agent 发布版本">
                      {conversation.releaseVersion === 0
                        ? "草稿试用"
                        : `v${conversation.releaseVersion}`}
                    </Tag>
                  </div>
                  <Tabs
                    className="conversation-view-tabs"
                    activeKey={tracing ? "trace" : "chat"}
                    onChange={(view) => {
                      const next = new URLSearchParams(searchParams);
                      if (view === "trace") next.set("view", view);
                      else {
                        next.delete("view");
                        next.delete("runId");
                        next.delete("recordId");
                      }
                      setSearchParams(next);
                    }}
                    items={[
                      { key: "chat", label: "对话" },
                      { key: "trace", label: "轨迹" },
                    ]}
                  />
                </header>
                <div className="chat-session" hidden={tracing}>
                  {conversation.parentConversationId && (
                    <p className="chat-branch-origin">
                      从编辑的消息继续 ·{" "}
                      <button
                        type="button"
                        onClick={() => onSelect(conversation.parentConversationId ?? undefined)}
                      >
                        查看原会话
                      </button>
                    </p>
                  )}
                  <ChatSession
                    key={conversation.id}
                    conversationId={conversation.id}
                    onFork={(id) => {
                      void refresh("conversations", "runs");
                      onSelect(id);
                    }}
                  />
                </div>
                {tracing && (
                  <ConversationTrace
                    key={conversation.id}
                    projectId={projectId}
                    conversationId={conversation.id}
                    focusRunId={searchParams.get("runId") ?? undefined}
                    focusRecordId={searchParams.get("recordId") ?? undefined}
                    onSelectRecord={(recordId, runId) => {
                      const next = new URLSearchParams(searchParams);
                      if (recordId) next.set("recordId", recordId);
                      else {
                        next.delete("recordId");
                        next.delete("runId");
                      }
                      if (runId) next.set("runId", runId);
                      setSearchParams(next, { replace: true });
                    }}
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
              <Button type="primary" onClick={() => setPicking(true)}>
                选择 Agent
              </Button>
            }
          />
        )}
      </div>
      <Modal
        title="选择一个 Agent 开始对话"
        open={picking}
        onCancel={() => setPicking(false)}
        footer={null}
        destroyOnHidden
      >
        <QueryState label="Agent" query={agentsQuery}>
          {agents.length ? (
            <div className="agent-picker">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="agent-picker-item"
                  disabled={!!connecting}
                  onClick={() => void startConversation(agent.id)}
                >
                  <RobotOutlined />
                  <span className="picker-text">
                    <strong>{agent.name}</strong>
                    <small>
                      已发布 v{agent.publishedVersion} · {agent.description || "未填写说明"}
                    </small>
                  </span>
                  {connecting === agent.id ? (
                    <Spin size="small" />
                  ) : (
                    <span className="picker-go">开始对话</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <Blank
              title="还没有已发布的 Agent"
              description="对话必须绑定一个已发布的 Agent。发布之后，它会立即出现在这里。"
              action={
                <Button
                  type="primary"
                  onClick={() => {
                    setPicking(false);
                    onConfigureAgents();
                  }}
                >
                  前往 Agents
                </Button>
              }
            />
          )}
        </QueryState>
      </Modal>
    </section>
  );
}
export function ChatSession({
  conversationId,
  onFork,
  onRunningChange,
}: {
  conversationId: string;
  onFork?: (id: string) => void;
  onRunningChange?: (running: boolean) => void;
}) {
  const [reset, setReset] = useState<{ source: string; id: string }>();
  const sourceId = conversationId;
  conversationId = reset?.source === sourceId ? reset.id : sourceId;
  const projectId = useProjectId(),
    refresh = useProjectRefresh();
  const query = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "messages"),
    queryFn: async ({ signal }) => {
      const session = await unwrap(
        api.getConversationSession({ path: { projectId, id: conversationId }, signal }),
        signal,
      );
      const validated = session.messages.length
        ? await validateUIMessages({ messages: session.messages })
        : [];
      signal.throwIfAborted();
      return { messages: validated, resumeRun: session.resumeRun };
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
            key={conversationId}
            onReset={(next) => {
              if (onFork) onFork(next.id);
              else setReset({ source: sourceId, id: next.id });
            }}
            projectId={projectId}
            conversationId={conversationId}
            messages={query.data.messages}
            resumeRun={query.data.resumeRun}
            onFinish={() => void refresh("runs", "conversations")}
            onFork={onFork}
            onRunningChange={onRunningChange}
          />
        </Suspense>
      )}
    </QueryState>
  );
}
