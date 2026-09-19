import type { Conversation } from "@platform/sdk";
import { Alert, Spin } from "antd";
import { lazy, Suspense } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentCollection, AgentWorkspace } from "../../features/agents/index";
import { ApplicationsWorkspace } from "../../features/applications/index";
import { ChatWorkspace } from "../../features/chat/index";
import { KnowledgeWorkspace } from "../../features/knowledge/index";
import { McpWorkspace } from "../../features/mcp/index";
import { MembersWorkspace } from "../../features/members/index";
import { ModelWorkspace } from "../../features/models/index";
import { Overview } from "../../features/overview/index";
import { RunsWorkspace } from "../../features/runs/index";
import { RuntimeInfoWorkspace } from "../../features/runtimes/index";
import { SkillWorkspace } from "../../features/skills/index";
import { ToolWorkspace } from "../../features/tools/index";
import { pagePermission, useProjectAccess } from "../../shared/access";
import { useProjectId, useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { type Page, projectPath } from "../../shared/navigation";
import { useConsoleNavigation } from "./context";

const Workflows = lazy(() =>
  import("../../features/workflows/index").then((m) => ({ default: m.WorkflowWorkspace })),
);
export function ProjectPage() {
  const { page, user, openEditor, registerGuard, refreshProjects } = useConsoleNavigation();
  const access = useProjectAccess();
  const can = (permission: string) => access?.permissions?.some((p) => p === permission) ?? false;
  const projectId = useProjectId(),
    { resourceId } = useParams(),
    navigate = useNavigate();
  const modelsQuery = useProjectQuery("models", {
    enabled: (page === "knowledge" || page === "workflows") && can("resource.edit"),
  });
  const go = (next: Page, id?: string) => {
    void navigate(projectPath(projectId, next, id));
  };
  const selection = { selectedId: resourceId, onSelect: (id?: string) => go(page, id) };
  const onConversation = (c: Conversation) => go("chat", c.id);
  const agentActions = {
    onEdit: (a?: Parameters<typeof openEditor>[1]) => openEditor("agent", a),
    onConversation,
    canEdit: can("agent.edit"),
    canViewConfiguration: can("resource.read"),
    canRun: can("agent.run"),
  };
  if (page === "team")
    return (access?.tenantRole ?? user.tenantRole) === "owner" ||
      (access?.tenantRole ?? user.tenantRole) === "admin" ? (
      <MembersWorkspace key="team" scope="team" user={user} />
    ) : (
      <Alert type="info" title="团队设置仅对管理员开放" />
    );
  if (!access) return <Spin description="读取项目权限…" />;
  if (!can(pagePermission(page)))
    return (
      <Alert
        type="info"
        title="当前项目角色没有此页面的操作权限"
        description="请联系项目管理员调整你的访问范围。"
      />
    );
  switch (page) {
    case "settings":
      return (
        <MembersWorkspace
          key={projectId}
          scope="project"
          user={user}
          refreshProjects={refreshProjects}
        />
      );
    case "overview":
      if (!can("resource.manage")) return <AgentCollection {...agentActions} />;
      return (
        <Overview
          navigate={go}
          onEdit={(a) => openEditor("agent", a)}
          onConversation={onConversation}
        />
      );
    case "agents":
      return resourceId ? (
        can("resource.read") ? (
          <AgentWorkspace
            selectedId={resourceId}
            onSelect={selection.onSelect}
            registerGuard={registerGuard}
            canEdit={can("agent.edit")}
            canPublish={can("agent.publish")}
          />
        ) : (
          <Alert type="info" title="当前角色可使用已发布 Agent，不能查看草稿配置。" />
        )
      ) : (
        <AgentCollection {...agentActions} />
      );
    case "models":
      return (
        <ModelWorkspace
          onCreate={() => openEditor("model")}
          onEdit={(model) => openEditor("model", model)}
        />
      );
    case "tools":
      return (
        <ToolWorkspace
          onCreate={() => openEditor("tool")}
          onEdit={(tool) => openEditor("tool", tool)}
        />
      );
    case "chat":
      return <ChatWorkspace {...selection} onConfigureAgents={() => go("agents")} />;
    case "skills":
      return <SkillWorkspace {...selection} />;
    case "mcp":
      return <McpWorkspace projectId={projectId} {...selection} />;
    case "runs":
      return <RunsWorkspace projectId={projectId} {...selection} />;
    case "applications":
      return <ApplicationsWorkspace projectId={projectId} />;
    case "runtimes":
      return <RuntimeInfoWorkspace user={user} />;
    case "knowledge":
      return (
        <QueryState label="模型服务" query={modelsQuery}>
          <KnowledgeWorkspace
            projectId={projectId}
            models={modelsQuery.data ?? []}
            onConfigureModels={() => go("models")}
            {...selection}
          />
        </QueryState>
      );
    case "workflows":
      return (
        <QueryState label="模型服务" query={modelsQuery}>
          <Suspense fallback={<Spin />}>
            <Workflows
              projectId={projectId}
              models={modelsQuery.data ?? []}
              registerGuard={registerGuard}
              {...selection}
            />
          </Suspense>
        </QueryState>
      );
  }
}
