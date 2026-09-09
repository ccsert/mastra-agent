import * as api from "@platform/sdk";
import { queryOptions } from "@tanstack/react-query";
import { unwrap, unwrapPage } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { pageOptions } from "../../shared/data/pages";

export const knowledgeQueries = {
  documents: (projectId: string, kbId: string) => ({
    ...pageOptions(projectKey(projectId, "knowledgeBases", kbId, "documents"), (cursor, signal) =>
      unwrapPage(
        api.listKnowledgeDocuments({
          path: { projectId, kbId },
          query: { cursor, limit: 20 },
          signal,
        }),
      ),
    ),
    refetchInterval: 2500,
  }),
  chunks: (projectId: string, kbId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "knowledgeBases", kbId, "chunks", id),
      queryFn: ({ signal }) =>
        unwrap(api.listKnowledgeChunks({ path: { projectId, kbId, id }, signal })),
      enabled: !!id,
    }),
  search: (projectId: string, kbId: string, id: string) =>
    queryOptions({
      queryKey: projectKey(projectId, "knowledgeBases", kbId, "search", id),
      queryFn: ({ signal }) =>
        unwrap(api.getKnowledgeSearch({ path: { projectId, kbId, id }, signal })),
      enabled: !!id,
      refetchInterval: (query) =>
        query.state.data && ["queued", "running"].includes(query.state.data.status) ? 700 : false,
    }),
};
