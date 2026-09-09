import * as api from "@platform/sdk";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { ConversationTrajectory, downloadTrace } from "./ConversationTrajectory";
import { projectConversation } from "./trajectory";

export function ConversationTrace({
  projectId,
  conversationId,
  focusRunId,
}: {
  projectId: string;
  conversationId: string;
  focusRunId?: string;
}) {
  const query = useInfiniteQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "trajectory"),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ signal, pageParam }) =>
      unwrap(
        api.getConversationTrace({
          path: { projectId, id: conversationId },
          query: { before: pageParam, limit: 10 },
          signal,
        }),
        signal,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    gcTime: 0,
    refetchInterval: 3000,
  });
  const pages = query.data?.pages ?? [];
  const byId = new Map<string, api.TraceTurn>();
  for (const page of pages)
    for (const turn of page.turns) if (!byId.has(turn.run.id)) byId.set(turn.run.id, turn);
  const turns = [...byId.values()].sort((a, b) => a.number - b.number);
  const [expanded, setExpanded] = useState(new Set<string>());
  const tails = useQueries({
    queries: turns.map((turn) => ({
      queryKey: projectKey(projectId, "runs", turn.run.id, "trace-tail", turn.run.status),
      enabled: expanded.has(turn.run.id) && turn.hasMoreEvents,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const events: api.RunEvent[] = [];
        let after = turn.events.at(-1)?.seq ?? -1;
        for (;;) {
          const batch = await unwrap(
            api.listRunEvents({ path: { projectId, id: turn.run.id }, query: { after }, signal }),
            signal,
          );
          events.push(...batch);
          if (batch.length < 500) return events;
          after = batch.at(-1)?.seq ?? after;
        }
      },
      gcTime: 0,
      refetchInterval: ["running", "queued"].includes(turn.run.status) ? 3000 : (false as const),
    })),
  });
  const merged = turns.map((turn, index) => ({
    ...turn,
    events: [
      ...new Map([...turn.events, ...(tails[index].data ?? [])].map((e) => [e.seq, e])).values(),
    ].sort((a, b) => a.seq - b.seq),
    hasMoreEvents: turn.hasMoreEvents && (!tails[index].data || tails[index].isError),
  }));
  const focusLoaded = turns.some((t) => t.run.id === focusRunId);
  useEffect(() => {
    if (focusRunId && !focusLoaded && query.hasNextPage && !query.isFetching && !query.isError)
      void query.fetchNextPage();
  }, [
    focusRunId,
    focusLoaded,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
  ]);
  return (
    <div className="conversation-trajectory">
      <QueryState label="会话轨迹" query={query}>
        {query.hasNextPage && (
          <Button
            size="small"
            loading={query.isFetching}
            onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
          >
            加载更早轮次
          </Button>
        )}
        {merged.map(
          (turn, index) =>
            turn.hasMoreEvents && (
              <div key={turn.run.id} className="trace-page-warning">
                {tails[index].isError && (
                  <Alert type="warning" title={`第 ${turn.number} 轮后续调用加载失败`} />
                )}
                <Button
                  size="small"
                  loading={tails[index].isFetching}
                  onClick={() => {
                    setExpanded((old) => new Set([...old, turn.run.id]));
                    if (tails[index].isError) void tails[index].refetch();
                  }}
                >
                  加载第 {turn.number} 轮后续调用
                </Button>
              </div>
            ),
        )}
        <ConversationTrajectory
          records={projectConversation(pages[0]?.initial ?? null, merged)}
          totalTurns={pages[0]?.totalTurns ?? 0}
          focusRunId={focusRunId}
          partial={query.hasNextPage || merged.some((t) => t.hasMoreEvents)}
        />
        <details className="trace-diagnostics">
          <summary>开发者诊断</summary>
          <p>协议数据用于排错，包含流式分片；Session 日志按消息与调用合并。</p>
          <Button
            size="small"
            onClick={() =>
              downloadTrace("session-protocol.json", {
                complete: !query.hasNextPage && merged.every((t) => !t.hasMoreEvents),
                turns: merged,
              })
            }
          >
            下载已加载的协议数据
          </Button>
        </details>
      </QueryState>
    </div>
  );
}
