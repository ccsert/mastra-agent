import * as api from "@platform/sdk";
import { unwrapPage } from "../api";
import { projectKey } from "./ProjectData";
import { pageOptions } from "./pages";

export const mcpQueries = {
  discoveries: (projectId: string, id: string) => ({
    ...pageOptions(projectKey(projectId, "mcpServers", id, "discoveries"), (cursor, signal) =>
      unwrapPage(
        api.listMcpDiscoveries({ path: { projectId, id }, query: { cursor, limit: 20 }, signal }),
      ),
    ),
    refetchInterval: 2000,
  }),
};
