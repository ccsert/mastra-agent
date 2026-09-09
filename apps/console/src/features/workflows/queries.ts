import * as api from "@platform/sdk";
import { queryOptions } from "@tanstack/react-query";
import { unwrap, unwrapPage } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { pageOptions } from "../../shared/data/pages";

export const workflowQueries = {
  releases: (projectId: string, id: string) => ({
    ...pageOptions(projectKey(projectId, "workflows", id, "releases"), (cursor, signal) =>
      unwrapPage(
        api.listWorkflowReleases({ path: { projectId, id }, query: { cursor, limit: 20 }, signal }),
      ),
    ),
    refetchInterval: false as const,
  }),
  runs: (projectId: string, id: string) => ({
    ...pageOptions(projectKey(projectId, "workflows", id, "runs"), (cursor, signal) =>
      unwrapPage(
        api.listWorkflowRuns({ path: { projectId, id }, query: { cursor, limit: 20 }, signal }),
      ),
    ),
    refetchInterval: 2000,
  }),
  generations: (projectId: string, id: string) => ({
    ...pageOptions(projectKey(projectId, "workflows", id, "generations"), (cursor, signal) =>
      unwrapPage(
        api.listWorkflowGenerations({
          path: { projectId, id },
          query: { cursor, limit: 20 },
          signal,
        }),
      ),
    ),
    refetchInterval: 2000,
  }),
  run: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "workflows", "run", id),
      queryFn: ({ signal }) => unwrap(api.getWorkflowRun({ path: { projectId, id }, signal })),
      refetchInterval: (query) =>
        query.state.data && ["queued", "running"].includes(query.state.data.status) ? 800 : false,
    }),
  nodes: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "workflows", "run", id, "nodes"),
      queryFn: ({ signal }) =>
        unwrap(api.listWorkflowNodeRuns({ path: { projectId, id }, signal })),
    }),
};
