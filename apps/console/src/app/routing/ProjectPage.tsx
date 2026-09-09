import type { Conversation } from "@platform/sdk";
import { Spin } from "antd";
import { lazy, Suspense } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentCollection } from "../../features/agents/index";
import { ApplicationsWorkspace } from "../../features/applications/index";
import { ChatWorkspace } from "../../features/chat/index";
import { KnowledgeWorkspace } from "../../features/knowledge/index";
import { McpWorkspace } from "../../features/mcp/index";
import { ModelWorkspace } from "../../features/models/index";
import { Overview } from "../../features/overview/index";
import { RunsWorkspace } from "../../features/runs/index";
import { RuntimeInfoWorkspace } from "../../features/runtimes/index";
import { SkillWorkspace } from "../../features/skills/index";
import { ToolWorkspace } from "../../features/tools/index";
import { useProjectId, useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { type Page, projectPath } from "../../shared/navigation";
import { useConsoleNavigation } from "./context";

const Workflows = lazy(() =>
  import("../../features/workflows/index").then((m) => ({ default: m.WorkflowWorkspace })),
);
export function ProjectPage() {
  const { page, openEditor, registerGuard } = useConsoleNavigation();
  const projectId = useProjectId(),
    { resourceId } = useParams(),
    navigate = useNavigate();
  const modelsQuery = useProjectQuery("models", {
    enabled: page === "knowledge" || page === "workflows",
  });
  const go = (next: Page, id?: string) => {
    void navigate(projectPath(projectId, next, id));
  };
  const selection = { selectedId: resourceId, onSelect: (id?: string) => go(page, id) };
  const onConversation = (c: Conversation) => go("chat", c.id);
  switch (page) {
    case "overview":
      return (
        <Overview
          navigate={go}
          onEdit={(a) => openEditor("agent", a)}
          onConversation={onConversation}
        />
      );
    case "agents":
      return (
        <AgentCollection onEdit={(a) => openEditor("agent", a)} onConversation={onConversation} />
      );
    case "models":
      return <ModelWorkspace onCreate={() => openEditor("model")} />;
    case "tools":
      return <ToolWorkspace onCreate={() => openEditor("tool")} />;
    case "chat":
      return <ChatWorkspace {...selection} onCreate={() => go("agents")} />;
    case "skills":
      return <SkillWorkspace {...selection} />;
    case "mcp":
      return <McpWorkspace projectId={projectId} {...selection} />;
    case "runs":
      return <RunsWorkspace projectId={projectId} {...selection} />;
    case "applications":
      return <ApplicationsWorkspace projectId={projectId} />;
    case "runtimes":
      return <RuntimeInfoWorkspace />;
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
