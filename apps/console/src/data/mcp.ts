import * as api from "@platform/sdk";
import { queryOptions } from "@tanstack/react-query";
import { unwrap } from "../api";
import { projectKey } from "./ProjectData";

export const mcpQueries = {
  discoveries: (projectId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "mcpServers", id, "discoveries"),
      queryFn: ({ signal }) => unwrap(api.listMcpDiscoveries({ path: { projectId, id }, signal })),
      refetchInterval: 2000,
    }),
};
