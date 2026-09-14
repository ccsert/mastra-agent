import {
  ApiOutlined,
  ArrowRightOutlined,
  BookOutlined,
  FileZipOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { Agent, Conversation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Tag } from "antd";
import { unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectId, useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { useOperation } from "../../shared/useOperation";
export type AgentActions = {
  onEdit(agent?: Agent): void;
  onConversation(item: Conversation): void;
  canEdit?: boolean;
  canViewConfiguration?: boolean;
  canRun?: boolean;
};
export function AgentCollection({
  limit,
  onEdit,
  onConversation,
  canEdit = true,
  canViewConfiguration = true,
  canRun = true,
}: AgentActions & { limit?: number }) {
  const projectId = useProjectId(),
    refresh = useProjectRefresh();
  const agentsQuery = useProjectQuery("agents"),
    modelsQuery = useProjectQuery("models", { enabled: canViewConfiguration });
  const agents = agentsQuery.data ?? [],
    models = modelsQuery.data ?? [];
  const { busy, error, run } = useOperation();
  function startChat(agent: Agent) {
    return run(async (signal) => {
      const item = await unwrap(
        api.createConversation({
          signal,
          path: { projectId },
          // Blank placeholder; the first message names the session.
          body: { agentId: agent.id, title: "新会话" },
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
            {canViewConfiguration && agent.publishedReleaseId && agent.hasUnpublishedChanges && (
              <Tag color="processing">有未发布修改</Tag>
            )}
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
              {!!agent.skillBindings?.length && (
                <span>
                  <FileZipOutlined /> {agent.skillBindings.length} 个 Skill
                </span>
              )}
              {!!agent.knowledgeBaseIds?.length && (
                <span>
                  <BookOutlined /> {agent.knowledgeBaseIds.length} 个知识库
                </span>
              )}
            </div>
            <div className="agent-actions">
              {canViewConfiguration && (
                <Button onClick={() => onEdit(agent)}>{canEdit ? "配置 Agent" : "查看配置"}</Button>
              )}
              <Button
                type="primary"
                disabled={!agent.publishedReleaseId || busy || !canRun}
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
