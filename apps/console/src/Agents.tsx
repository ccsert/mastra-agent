import {
  ApiOutlined,
  ArrowRightOutlined,
  BookOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { Agent, Conversation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, App as AntApp, Button, Tag } from "antd";
import { useState } from "react";
import { unwrap } from "./api";
import { Blank } from "./Blank";
import { useProjectId, useProjectQuery, useProjectRefresh } from "./data/ProjectData";
import { QueryState } from "./data/QueryState";
import { useOperation } from "./useOperation";
export type AgentActions = {
  onEdit(agent?: Agent): void;
  onConversation(item: Conversation): void;
};
export function AgentCollection({
  limit,
  onEdit,
  onConversation,
}: AgentActions & { limit?: number }) {
  const projectId = useProjectId(),
    refresh = useProjectRefresh(),
    { message } = AntApp.useApp();
  const agentsQuery = useProjectQuery("agents"),
    modelsQuery = useProjectQuery("models");
  const agents = agentsQuery.data ?? [],
    models = modelsQuery.data ?? [];
  const [publishing, setPublishing] = useState("");
  const { busy, error, run } = useOperation();
  function publish(agent: Agent) {
    setPublishing(agent.id);
    return run(async (signal) => {
      const release = await unwrap(
        api.publishAgent({
          signal,
          path: { projectId, id: agent.id },
          body: { baseRevision: agent.draftRevision },
        }),
        signal,
      );
      void message.success(`已发布 v${release.version}`);
      void refresh("agents", "workflowCatalog");
    });
  }
  function startChat(agent: Agent) {
    setPublishing("");
    return run(async (signal) => {
      const item = await unwrap(
        api.createConversation({
          signal,
          path: { projectId },
          body: { agentId: agent.id, title: agent.name },
        }),
        signal,
      );
      void refresh("conversations");
      onConversation(item);
    });
  }
  function cards(items: Agent[]) {
    return (
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
              {!!agent.knowledgeBaseIds?.length && (
                <span>
                  <BookOutlined /> {agent.knowledgeBaseIds.length} 个知识库
                </span>
              )}
            </div>
            <div className="agent-actions">
              <Button onClick={() => onEdit(agent)}>编辑</Button>
              <Button
                loading={publishing === agent.id && busy}
                disabled={busy}
                onClick={() => void publish(agent)}
              >
                发布
              </Button>
              <Button
                type="primary"
                disabled={!agent.publishedReleaseId || busy}
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
  }
  return (
    <>
      {error && <Alert type="error" title={error} />}
      {!limit && (
        <QueryState label="模型服务" query={modelsQuery}>
          {null}
        </QueryState>
      )}
      <QueryState label="Agents" query={agentsQuery}>
        {agents.length ? (
          cards(limit ? agents.slice(0, limit) : agents)
        ) : (
          <section className="panel">
            <Blank
              title="创建第一个 Agent"
              description="为它选择模型，写下角色指令，并绑定允许使用的工具。"
              action={
                <Button type="primary" onClick={() => onEdit()}>
                  创建 Agent
                </Button>
              }
            />
          </section>
        )}
      </QueryState>
    </>
  );
}
