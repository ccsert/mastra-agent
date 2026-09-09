import type {
  Agent,
  Application,
  Conversation,
  KnowledgeBase,
  McpServer,
  Model,
  Run,
  RuntimeInfo,
  SkillVersion,
  Tool,
  WorkflowAsset,
  WorkflowCapability,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { unwrap, unwrapPage } from "../api";

import { pageOptions } from "./pages";

type Resources = {
  agents: Agent[];
  skills: SkillVersion[];
  applications: Application[];
  conversations: Conversation[];
  knowledgeBases: KnowledgeBase[];
  models: Model[];
  runs: Run[];
  runtimes: RuntimeInfo[];
  tools: Tool[];
  mcpServers: McpServer[];
  workflows: WorkflowAsset[];
  workflowCatalog: WorkflowCapability[];
};
type Resource = keyof Resources;
type QueryResource = Exclude<Resource, "conversations" | "workflows">;
const loaders: {
  [K in QueryResource]: (projectId: string, signal: AbortSignal) => Promise<Resources[K]>;
} = {
  skills: async (projectId, signal) => {
    const items: SkillVersion[] = [];
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await unwrapPage(
        api.listSkills({ path: { projectId }, query: { cursor, limit: 100 }, signal }),
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  },
  agents: (projectId, signal) => unwrap(api.listAgents({ path: { projectId }, signal })),
  applications: (projectId, signal) =>
    unwrap(api.listApplications({ path: { projectId }, signal })),
  knowledgeBases: (projectId, signal) =>
    unwrap(api.listKnowledgeBases({ path: { projectId }, signal })),
  models: (projectId, signal) => unwrap(api.listModels({ path: { projectId }, signal })),
  runs: (projectId, signal) => unwrap(api.listRuns({ path: { projectId }, signal })),
  runtimes: (_projectId, signal) => unwrap(api.listRuntimes({ signal })),
  tools: (projectId, signal) => unwrap(api.listTools({ path: { projectId }, signal })),
  mcpServers: (projectId, signal) => unwrap(api.listMcpServers({ path: { projectId }, signal })),
  workflowCatalog: (projectId, signal) =>
    unwrap(api.getWorkflowCatalog({ path: { projectId }, signal })),
};
const ProjectContext = createContext<string | null>(null);
export const projectKey = (projectId: string, resource: Resource, ...ids: string[]) =>
  ["project", projectId, resource, ...ids] as const;

/** Mount beneath the authenticated workspace, keyed by project. No cache survives that boundary. */
export function ProjectData({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, gcTime: 300_000, retry: false } },
      }),
  );
  const lifetime = useRef(0);
  useEffect(() => {
    const current = ++lifetime.current;
    return () => {
      // Cancel immediately; clear after child observers detach and cancellation settles.
      // A StrictMode re-mount owns the same client and must not be cleared by the old cleanup.
      void client.cancelQueries().then(() => {
        if (lifetime.current === current) client.clear();
      });
    };
  }, [client]);
  return (
    <ProjectContext.Provider value={projectId}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ProjectContext.Provider>
  );
}
export function useProjectId() {
  const projectId = useContext(ProjectContext);
  if (projectId === null) throw new Error("ProjectData provider required");
  return projectId;
}
export function useProjectQuery<K extends QueryResource>(
  resource: K,
  { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean | number } = {},
) {
  const projectId = useProjectId();
  return useQuery({
    queryKey: projectKey(projectId, resource),
    queryFn: ({ signal }) => loaders[resource](projectId, signal),
    enabled: !!projectId && enabled,
    refetchInterval: typeof poll === "number" ? poll : poll ? 5000 : false,
  });
}
export function useProjectRefresh() {
  const client = useQueryClient(),
    projectId = useProjectId();
  return (...resources: Resource[]) =>
    resources.length
      ? Promise.all(
          resources.map((resource) =>
            client.invalidateQueries({ queryKey: projectKey(projectId, resource) }),
          ),
        )
      : client.refetchQueries({ type: "active" }, { cancelRefetch: false });
}

const pageLoaders = {
  conversations: (projectId: string, cursor: string | undefined, signal: AbortSignal) =>
    unwrapPage(
      api.listConversations({ path: { projectId }, query: { cursor, limit: 20 }, signal }),
    ),
  skills: (projectId: string, cursor: string | undefined, signal: AbortSignal) =>
    unwrapPage(api.listSkills({ path: { projectId }, query: { cursor, limit: 20 }, signal })),
  runs: (projectId: string, cursor: string | undefined, signal: AbortSignal) =>
    unwrapPage(api.listRuns({ path: { projectId }, query: { cursor, limit: 20 }, signal })),
  workflows: (projectId: string, cursor: string | undefined, signal: AbortSignal) =>
    unwrapPage(api.listWorkflows({ path: { projectId }, query: { cursor, limit: 20 }, signal })),
};
export function useProjectPages<K extends keyof typeof pageLoaders>(
  resource: K,
  { enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {},
) {
  const projectId = useProjectId();
  return useInfiniteQuery({
    ...pageOptions<Resources[K][number]>(
      projectKey(projectId, resource, "pages"),
      (cursor, signal) => pageLoaders[resource](projectId, cursor, signal),
    ),
    enabled: !!projectId && enabled,
    refetchInterval: poll ? 5000 : false,
  });
}
