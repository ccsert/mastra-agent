import type {
  Agent,
  Application,
  Conversation,
  KnowledgeBase,
  Model,
  Run,
  RuntimeInfo,
  Tool,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { unwrap } from "../api";

type Resources = {
  agents: Agent[];
  applications: Application[];
  conversations: Conversation[];
  knowledgeBases: KnowledgeBase[];
  models: Model[];
  runs: Run[];
  runtimes: RuntimeInfo[];
  tools: Tool[];
};
type Resource = keyof Resources;
const loaders: {
  [K in Resource]: (projectId: string, signal: AbortSignal) => Promise<Resources[K]>;
} = {
  agents: (projectId, signal) => unwrap(api.listAgents({ path: { projectId }, signal })),
  applications: (projectId, signal) =>
    unwrap(api.listApplications({ path: { projectId }, signal })),
  conversations: (projectId, signal) =>
    unwrap(api.listConversations({ path: { projectId }, signal })),
  knowledgeBases: (projectId, signal) =>
    unwrap(api.listKnowledgeBases({ path: { projectId }, signal })),
  models: (projectId, signal) => unwrap(api.listModels({ path: { projectId }, signal })),
  runs: (projectId, signal) => unwrap(api.listRuns({ path: { projectId }, signal })),
  runtimes: (_projectId, signal) => unwrap(api.listRuntimes({ signal })),
  tools: (projectId, signal) => unwrap(api.listTools({ path: { projectId }, signal })),
};
const ProjectContext = createContext<string | null>(null);
const key = (projectId: string, resource: Resource) => ["project", projectId, resource] as const;

/** Mount beneath the authenticated workspace, keyed by project. No cache survives that boundary. */
export function ProjectData({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        // This cache has a project lifetime; its owner clears it instead of a second GC timer.
        defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity, retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <ProjectContext.Provider value={projectId}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ProjectContext.Provider>
  );
}
function useProjectId() {
  const projectId = useContext(ProjectContext);
  if (projectId === null) throw new Error("ProjectData provider required");
  return projectId;
}
export function useProjectQuery<K extends Resource>(
  resource: K,
  { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {},
) {
  const projectId = useProjectId();
  return useQuery({
    queryKey: key(projectId, resource),
    queryFn: ({ signal }) => loaders[resource](projectId, signal),
    enabled: !!projectId && enabled,
    refetchInterval: poll ? 5000 : false,
  });
}
export function useProjectRefresh() {
  const client = useQueryClient(),
    projectId = useProjectId();
  return (...resources: Resource[]) =>
    resources.length
      ? Promise.all(
          resources.map((resource) =>
            client.invalidateQueries({ queryKey: key(projectId, resource) }),
          ),
        )
      : client.refetchQueries({ type: "active" }, { cancelRefetch: false });
}
