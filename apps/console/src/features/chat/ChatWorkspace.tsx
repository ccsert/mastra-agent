import {
  CommentOutlined,
  DeleteOutlined,
  EditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RobotOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import * as api from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { validateUIMessages } from "ai";
import { App as AntApp, Button, Input, Modal, Popconfirm, Spin, Tabs, Tag, Tooltip } from "antd";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { timestamp, unwrap, unwrapPage } from "../../shared/api";
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
import { readSessionValue, writeSessionValue } from "../../shared/data/session-storage";
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
  // Entering 对话 without a conversation id (menu clicks land on /chat) returns
  // to the conversation you last viewed in this project — never a blank pane.
  // The selectedId guard also makes re-clicking 对话 keep the current one.
  const lastConversationKey = useCallback(
    (id: string) =>
      storageScope ? `${storageScope}:${projectId}:${id}:last-conversation` : undefined,
    [storageScope, projectId],
  );
  useEffect(() => {
    if (selectedId) writeSessionValue(lastConversationKey("viewed"), selectedId);
  }, [selectedId, lastConversationKey]);
  useEffect(() => {
    if (selectedId || !query.isSuccess) return;
    const saved = readSessionValue(lastConversationKey("viewed"));
    const savedId = typeof saved === "string" ? saved : "";
    const known = !!savedId && conversations.some((c) => c.id === savedId);
    const target = known ? savedId : conversations[0]?.id;
    if (!target) return;
    if (savedId && !known) writeSessionValue(lastConversationKey("viewed"), undefined);
    onSelect(target);
  }, [conversations, selectedId, onSelect, lastConversationKey, query.isSuccess]);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string }>();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const pinnedQuery = useQuery({
    queryKey: projectKey(projectId, "conversations", "pins"),
    queryFn: ({ signal }) =>
      unwrapPage(
        api.listConversations({
          path: { projectId },
          query: { pinned: "true", limit: 50 },
          signal,
        }),
      ),
    gcTime: 0,
    staleTime: 0,
  });
  const pinnedItems = pinnedQuery.data?.items ?? [];
  async function togglePin(c: api.Conversation) {
    try {
      await unwrap(
        api.updateConversation({ path: { projectId, id: c.id }, body: { pinned: !c.pinnedAt } }),
      );
      await refresh("conversations");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "置顶失败");
    }
  }
  async function renameConversation(id: string, title: string) {
    const next = title.trim();
    if (!next) return;
    try {
      await unwrap(api.updateConversation({ path: { projectId, id }, body: { title: next } }));
      await refresh("conversations");
      void message.success("已重命名");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "重命名失败");
    }
  }
  const titleCommitting = useRef(false);
  async function commitTitle() {
    if (!titleEditing || titleCommitting.current || !conversation) return;
    titleCommitting.current = true;
    const next = titleDraft.trim();
    setTitleEditing(false);
    try {
      if (next && next !== conversation.title) await renameConversation(conversation.id, next);
    } finally {
      titleCommitting.current = false;
    }
  }
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
          <Input
            size="small"
            className="conversation-search"
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            allowClear
            prefix={<SearchOutlined />}
            onChange={(e) => setSearch(e.target.value)}
          />
          <QueryState label="会话" query={query}>
            <ConversationListBody
              conversations={conversations}
              pinned={pinnedItems}
              activeId={conversation?.id}
              search={search}
              deleting={deleting}
              renaming={renaming}
              onOpen={onSelect}
              onPin={togglePin}
              onDelete={removeConversation}
              onRenameStart={(c) => setRenaming({ id: c.id, value: c.title })}
              onRenameChange={(value) => setRenaming((old) => (old ? { ...old, value } : old))}
              onRenameCommit={() => {
                if (renaming) void renameConversation(renaming.id, renaming.value);
                setRenaming(undefined);
              }}
              onRenameCancel={() => setRenaming(undefined)}
            />
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
                    {titleEditing ? (
                      <input
                        className="chat-title-rename"
                        value={titleDraft}
                        ref={(node) => node?.focus()}
                        aria-label="重命名会话"
                        maxLength={100}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitTitle();
                          if (e.key === "Escape") setTitleEditing(false);
                        }}
                        onBlur={() => void commitTitle()}
                      />
                    ) : (
                      <>
                        <h1>{conversation.title}</h1>
                        <Tooltip title="点击标题可重命名">
                          <Button
                            type="text"
                            size="small"
                            aria-label="重命名会话"
                            icon={<EditOutlined />}
                            className="chat-title-edit"
                            onClick={() => {
                              setTitleDraft(conversation.title);
                              setTitleEditing(true);
                            }}
                          />
                        </Tooltip>
                      </>
                    )}
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
                      由消息编辑派生 ·{" "}
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
        ) : conversations.length ? null : (
          <div className="chat-empty-session">
            <div className="chat-welcome">
              <span className="chat-welcome-icon">
                <RobotOutlined />
              </span>
              <h2>今天，一起完成什么？</h2>
              <p>从左侧继续历史会话，或选择已发布的 Agent 开始新对话。</p>
            </div>
            <button
              type="button"
              className="composer chat-composer-mock"
              onClick={() => setPicking(true)}
              aria-label="选择 Agent 开始新对话"
            >
              <span className="chat-composer-mock-text">描述你的任务，从选择 Agent 开始…</span>
              <span className="chat-composer-mock-action">选择 Agent</span>
            </button>
          </div>
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
    <QueryState
      label="会话历史"
      query={query}
      loading={
        <div className="chat-skeleton" role="status" aria-label="加载会话历史">
          {["bubble-user-1", "bubble-assistant-1", "bubble-user-2", "bubble-assistant-2"].map(
            (key) => (
              <div
                key={key}
                className={`chat-skeleton-bubble ${key.includes("user") ? "user" : "assistant"}`}
              />
            ),
          )}
        </div>
      }
    >
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

type ConversationItemProps = {
  c: api.Conversation;
  active: boolean;
  deleting: boolean;
  renaming?: string;
  onOpen(): void;
  onPin(): void;
  onDelete(): void;
  onRenameStart(): void;
  onRenameChange(value: string): void;
  onRenameCommit(): void;
  onRenameCancel(): void;
};

function ConversationItem({
  c,
  active,
  deleting,
  renaming,
  onOpen,
  onPin,
  onDelete,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: ConversationItemProps) {
  return (
    <div className={active ? "conversation-item selected" : "conversation-item"}>
      {renaming !== undefined ? (
        <input
          className="conversation-rename"
          value={renaming}
          ref={(node) => node?.focus()}
          aria-label="重命名会话"
          onChange={(event) => onRenameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onRenameCommit();
            if (event.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameCommit}
        />
      ) : (
        <>
          <button type="button" className="conversation-open" onClick={onOpen}>
            {c.pinnedAt ? <PushpinFilled className="conversation-pin-flag" /> : <CommentOutlined />}
            <span>
              <strong>{c.title}</strong>
              <small>
                {c.releaseVersion === 0 ? "草稿试用" : `v${c.releaseVersion}`} ·{" "}
                {timestamp(c.createdAt)}
              </small>
            </span>
          </button>
          <div className="conversation-actions">
            <Tooltip title={c.pinnedAt ? "取消置顶" : "置顶"}>
              <Button
                size="small"
                type="text"
                aria-label={c.pinnedAt ? `取消置顶会话 ${c.title}` : `置顶会话 ${c.title}`}
                icon={c.pinnedAt ? <PushpinFilled /> : <PushpinOutlined />}
                onClick={onPin}
              />
            </Tooltip>
            <Tooltip title="重命名">
              <Button
                size="small"
                type="text"
                aria-label={`重命名会话 ${c.title}`}
                icon={<EditOutlined />}
                onClick={onRenameStart}
              />
            </Tooltip>
            <Popconfirm
              title="删除此会话？"
              description="会话、消息和运行记录将一并删除。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={onDelete}
            >
              <Button
                type="text"
                size="small"
                aria-label={`删除会话 ${c.title}`}
                loading={deleting}
                icon={<DeleteOutlined />}
              />
            </Popconfirm>
          </div>
        </>
      )}
    </div>
  );
}

const recencyGroups = [
  ["今天", "today"],
  ["昨天", "yesterday"],
  ["近 7 天", "week"],
  ["更早", "older"],
] as const;

function recencyGroup(iso: string): (typeof recencyGroups)[number][1] {
  const time = Date.parse(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (time >= +startOfToday) return "today";
  if (time >= +startOfToday - 86400000) return "yesterday";
  if (time >= +startOfToday - 7 * 86400000) return "week";
  return "older";
}

function ConversationListBody({
  conversations,
  pinned,
  activeId,
  search,
  deleting,
  renaming,
  onOpen,
  onPin,
  onDelete,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: {
  conversations: api.Conversation[];
  pinned: api.Conversation[];
  activeId?: string;
  search: string;
  deleting: string;
  renaming?: { id: string; value: string };
  onOpen(id: string): void;
  onPin(c: api.Conversation): void;
  onDelete(id: string): void;
  onRenameStart(c: api.Conversation): void;
  onRenameChange(value: string): void;
  onRenameCommit(): void;
  onRenameCancel(): void;
}) {
  const keyword = search.trim().toLowerCase();
  const matches = (c: api.Conversation) => !keyword || c.title.toLowerCase().includes(keyword);
  const pinnedIds = new Set(pinned.map((c) => c.id));
  const pinnedShown = pinned.filter(matches);
  const rest = conversations.filter((c) => !pinnedIds.has(c.id) && matches(c));
  const sections: [string, api.Conversation[]][] = keyword
    ? [["搜索结果", rest]]
    : [
        ...(pinnedShown.length ? ([["置顶", pinnedShown]] as [string, api.Conversation[]][]) : []),
        ...recencyGroups
          .map(
            ([label, key]) =>
              [label, rest.filter((c) => recencyGroup(c.createdAt) === key)] as [
                string,
                api.Conversation[],
              ],
          )
          .filter(([, items]) => items.length > 0),
      ];
  if (!sections.length)
    return (
      <p className="muted small-pad">
        {conversations.length || pinned.length
          ? "没有匹配的会话。"
          : "从已发布的 Agent 开始一段新对话。"}
      </p>
    );
  return (
    <>
      {sections.map(([label, items]) => (
        <div key={label} className="conversation-group">
          <p className="conversation-group-label">{label}</p>
          {items.map((c) => (
            <ConversationItem
              key={c.id}
              c={c}
              active={c.id === activeId}
              deleting={deleting === c.id}
              renaming={renaming?.id === c.id ? renaming.value : undefined}
              onOpen={() => onOpen(c.id)}
              onPin={() => onPin(c)}
              onDelete={() => onDelete(c.id)}
              onRenameStart={() => onRenameStart(c)}
              onRenameChange={onRenameChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ))}
    </>
  );
}
