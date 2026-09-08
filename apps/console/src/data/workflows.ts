import * as api from "@platform/sdk";
import { queryOptions } from "@tanstack/react-query";
import { unwrap } from "../api";
import { projectKey } from "./ProjectData";

export const workflowQueries = {
  releases: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "workflows", id, "releases"),
      queryFn: ({ signal }) =>
        unwrap(api.listWorkflowReleases({ path: { projectId, id }, signal })),
    }),
  runs: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "workflows", id, "runs"),
      queryFn: ({ signal }) => unwrap(api.listWorkflowRuns({ path: { projectId, id }, signal })),
      refetchInterval: 2000,
    }),
  generations: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "workflows", id, "generations"),
      queryFn: ({ signal }) =>
        unwrap(api.listWorkflowGenerations({ path: { projectId, id }, signal })),
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
