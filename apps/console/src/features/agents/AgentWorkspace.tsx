import { Alert } from "antd";
import { useProjectId, useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { AgentEditor } from "./AgentEditor";
export function AgentWorkspace({
  selectedId,
  onSelect,
  registerGuard,
  canEdit,
  canPublish,
}: {
  selectedId: string;
  onSelect(id?: string): void;
  registerGuard(guard?: () => "busy" | "dirty" | null): void;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const projectId = useProjectId(),
    agents = useProjectQuery("agents"),
    agent = agents.data?.find((a) => a.id === selectedId);
  if (selectedId === "new" && !canEdit) return <Alert type="info" title="当前角色不能创建 Agent" />;
  return (
    <QueryState label="Agent 配置" query={agents}>
      {selectedId !== "new" && !agent ? (
        <Alert type="warning" title="Agent 不存在或当前角色无权访问" />
      ) : (
        <AgentEditor
          projectId={projectId}
          agent={agent}
          onClose={() => onSelect()}
          onSaved={() => {}}
          onCreated={(agent) => onSelect(agent.id)}
          registerGuard={registerGuard}
          canEdit={canEdit}
          canPublish={canPublish}
        />
      )}
    </QueryState>
  );
}
