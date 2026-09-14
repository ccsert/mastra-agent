import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import {
  conversationTracePath,
  projectPath,
  type ResourceSelection,
} from "../../shared/navigation";

/** Legacy /runs/:id links resolve to the owning conversation's trajectory. */
function RunLocation({ projectId, id }: { projectId: string; id: string }) {
  const query = useQuery({
    queryKey: projectKey(projectId, "runs", id, "detail"),
    queryFn: ({ signal }) => unwrap(api.getRun({ path: { projectId, id }, signal }), signal),
    gcTime: 0,
  });
  return (
    <QueryState label="运行所属会话" query={query}>
      {query.data && (
        <Navigate replace to={conversationTracePath(projectId, query.data.conversationId, id)} />
      )}
    </QueryState>
  );
}
/** The per-conversation trajectory supersedes the old project-wide run list. */
export function RunsWorkspace({
  projectId,
  selectedId,
}: ResourceSelection & { projectId: string }) {
  if (selectedId) return <RunLocation projectId={projectId} id={selectedId} />;
  return <Navigate replace to={projectPath(projectId, "chat")} />;
}
