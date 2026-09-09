import * as api from "@platform/sdk";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Drawer } from "antd";
import { useState } from "react";
import { timestamp, unwrapPage } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { PageMore, pageItems, pageOptions } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import { RunDetails } from "./RunDetails";
import { RunStatus } from "./RunStatus";

export function ConversationRuns({
  projectId,
  conversationId,
  onClose,
}: {
  projectId: string;
  conversationId: string;
  onClose(): void;
}) {
  const [selected, setSelected] = useState<string>();
  const query = useInfiniteQuery({
    ...pageOptions(
      projectKey(projectId, "conversations", conversationId, "runs"),
      (cursor, signal) =>
        unwrapPage(
          api.listConversationRuns({
            path: { projectId, id: conversationId },
            query: { cursor, limit: 20 },
            signal,
          }),
        ),
    ),
    gcTime: 0,
    refetchInterval: 3000,
  });
  const runs = pageItems(query.data),
    id = selected ?? runs[0]?.id;
  return (
    <Drawer title="会话运行轨迹" open onClose={onClose} size={1240}>
      <div className="conversation-traces">
        <aside>
          <QueryState label="会话运行记录" query={query}>
            {!runs.length && <p>此会话尚无运行记录。</p>}
            {runs.map((run) => (
              <button
                type="button"
                key={run.id}
                className={id === run.id ? "conversation-trace selected" : "conversation-trace"}
                onClick={() => setSelected(run.id)}
              >
                <strong>{run.inputText?.slice(0, 60) || "未记录输入正文"}</strong>
                <small>{timestamp(run.createdAt)}</small>
                <RunStatus status={run.status} />
              </button>
            ))}
            <PageMore query={query} count={runs.length} label="运行" />
          </QueryState>
        </aside>
        <div>{id && <RunDetails key={id} projectId={projectId} id={id} />}</div>
      </div>
    </Drawer>
  );
}
