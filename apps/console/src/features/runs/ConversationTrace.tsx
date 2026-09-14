import * as api from "@platform/sdk";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { ConversationTrajectory, downloadTrace } from "./ConversationTrajectory";
import { FULL_TIMELINE, type TimelineWindow } from "./timeline-window";
import { loadFullTrace } from "./trace-loading";
import { createTraceReader } from "./trace-reader";
import { createConversationProjector, projectConversation, sessionLog } from "./trajectory";

function ConversationTraceReader({
  projectId,
  conversationId,
  focusRunId,
  focusRecordId,
  onSelectRecord,
}: {
  projectId: string;
  conversationId: string;
  focusRunId?: string;
  focusRecordId?: string;
  onSelectRecord?(recordId: string, runId?: string): void;
}) {
  const [snapshot, setSnapshot] = useState<api.ConversationTrace>();
  const [loadingAll, setLoadingAll] = useState(false);
  const [progress, setProgress] = useState("");
  const [loadError, setLoadError] = useState("");
  const reader = useMemo(() => createTraceReader(), []);
  const projector = useMemo(() => createConversationProjector(), []);
  const [tailProgress, setTailProgress] = useState(new Map<string, api.RunEvent[]>());
  const allController = useRef<AbortController | null>(null);
  useEffect(() => () => allController.current?.abort(), []);
  async function loadAll(exporting = false) {
    if (allController.current) return;
    const controller = new AbortController();
    allController.current = controller;
    setLoadingAll(true);
    setLoadError("");
    try {
      const full = await loadFullTrace(
        projectId,
        conversationId,
        controller.signal,
        (loaded, total, partial) => {
          setProgress(`已读取 ${loaded} / ${total} 轮`);
          if (!exporting) setSnapshot(partial);
        },
        (turn, signal) => reader.read(projectId, turn, signal, () => {}, Number.MAX_SAFE_INTEGER),
      );
      controller.signal.throwIfAborted();
      if (!exporting) setSnapshot(full);
      if (exporting)
        downloadTrace(`conversation-${conversationId}.json`, {
          formatVersion: 1,
          conversationId,
          exportedAt: new Date().toISOString(),
          scope: "全部轮次，每轮截至 checkpoint.lastSeq；导出期间的新事件不包含在内",
          complete: true,
          live: full.turns.some((t) => ["running", "queued"].includes(t.run.status)),
          records: sessionLog(projectConversation(full.initial, full.turns)),
          protocol: full,
        });
    } catch (error) {
      if (!controller.signal.aborted)
        setLoadError(error instanceof Error ? error.message : "读取完整轨迹失败");
    } finally {
      if (allController.current === controller) {
        allController.current = null;
        setLoadingAll(false);
        setProgress("");
      }
    }
  }
  const retained = useRef(new Map<string, api.TraceTurn>());
  // Settled history is never polled. An older queued/running turn can fall
  // outside the newest page, so refresh only pages that contain those turns.
  // Pages carry turn summaries; events stream in per turn through the reader.
  const head = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "trajectory", "head"),
    queryFn: async ({ signal }) => {
      const read = (before?: number) =>
        unwrap(
          api.getConversationTrace({
            path: { projectId, id: conversationId },
            query: { before, limit: 10, events: "summary" },
            signal,
          }),
          signal,
        );
      const latest = await read();
      const found = new Set(latest.turns.map((turn) => turn.run.id));
      const active = [...retained.current.values()].filter(
        (turn) => !found.has(turn.run.id) && ["running", "queued"].includes(turn.run.status),
      );
      const turns = [...latest.turns];
      // Sequential page reads avoid a second concurrency burst for metadata.
      for (const turn of active.sort((a, b) => b.number - a.number)) {
        if (found.has(turn.run.id)) continue;
        const page = await read(turn.number + 1);
        for (const item of page.turns) {
          if (!found.has(item.run.id)) turns.push(item);
          found.add(item.run.id);
        }
      }
      return { ...latest, turns };
    },
    gcTime: 0,
    structuralSharing: false,
    refetchInterval: (query) =>
      query.state.data?.turns.some((t) => ["running", "queued"].includes(t.run.status)) ||
      [...retained.current.values()].some((t) => ["running", "queued"].includes(t.run.status))
        ? 3000
        : false,
  });
  const history = useInfiniteQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "trajectory", "history"),
    initialPageParam: undefined as number | undefined,
    enabled: false,
    queryFn: ({ signal, pageParam }) =>
      unwrap(
        api.getConversationTrace({
          path: { projectId, id: conversationId },
          query: {
            before: pageParam ?? head.data?.nextBefore ?? undefined,
            limit: 10,
            events: "summary",
          },
          signal,
        }),
        signal,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    gcTime: 0,
    structuralSharing: false,
  });
  const pages = history.data?.pages;
  const turns = useMemo(() => {
    const byId = retained.current;
    for (const page of pages ?? [])
      for (const turn of page.turns) if (!byId.has(turn.run.id)) byId.set(turn.run.id, turn);
    for (const turn of head.data?.turns ?? []) {
      const previous = byId.get(turn.run.id);
      if (
        previous?.checkpoint &&
        turn.checkpoint &&
        previous.checkpoint.lastSeq === turn.checkpoint.lastSeq &&
        JSON.stringify(previous.run) === JSON.stringify(turn.run)
      )
        continue;
      byId.set(turn.run.id, turn);
    }
    for (const turn of snapshot?.turns ?? []) {
      const fresh = byId.get(turn.run.id);
      if (
        !fresh ||
        (fresh.run.status === turn.run.status &&
          (fresh.checkpoint?.lastSeq ?? -1) <= (turn.checkpoint?.lastSeq ?? -1))
      )
        byId.set(turn.run.id, turn);
    }
    return [...byId.values()].sort((a, b) => a.number - b.number);
  }, [pages, head.data, snapshot]);
  const [visibleWindow, setVisibleWindow] = useState<TimelineWindow>(FULL_TIMELINE);
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const requestTurn = useCallback((runId: string) => {
    setRequested((old) => (old.has(runId) ? old : new Set(old).add(runId)));
  }, []);
  // Event reads follow what the user can act on: live turns, the focus turn,
  // explicit requests and turns inside the visible timeline window. The full
  // window carries no zoom information, so only the newest turns preheat.
  const wanted = useMemo(() => {
    const picked = new Set<string>();
    const rest: { id: string; number: number; at: number }[] = [];
    for (const turn of turns) {
      if (
        requested.has(turn.run.id) ||
        turn.run.id === focusRunId ||
        ["running", "queued"].includes(turn.run.status)
      )
        picked.add(turn.run.id);
      else rest.push({ id: turn.run.id, number: turn.number, at: Date.parse(turn.run.createdAt) });
    }
    const times = rest.map((turn) => turn.at);
    const start = times.length ? Math.min(...times) : 0;
    const span = Math.max(1, (times.length ? Math.max(...times) : 0) - start);
    const slot = (span / Math.max(1, rest.length)) * 1.5;
    const from = start + (visibleWindow.start / 100) * span;
    const to = start + (visibleWindow.end / 100) * span;
    const candidates =
      visibleWindow.end - visibleWindow.start >= 100
        ? [...rest].sort((a, b) => b.number - a.number).slice(0, 8)
        : rest.filter((turn) => turn.at + slot >= from && turn.at <= to);
    for (const turn of candidates) picked.add(turn.id);
    return picked;
  }, [turns, requested, focusRunId, visibleWindow]);
  const tails = useQueries({
    queries: turns.map((turn) => ({
      queryKey: projectKey(
        projectId,
        "runs",
        turn.run.id,
        "trace-tail",
        turn.run.status,
        String(turn.checkpoint?.lastSeq ?? "live"),
      ),
      // Every act-on-able turn follows its tail; other turns stay as summaries
      // until they enter the window or the user asks for them.
      enabled: turn.hasMoreEvents && wanted.has(turn.run.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        reader.read(
          projectId,
          turn,
          signal,
          (events) => {
            if (signal.aborted) return;
            setTailProgress((old) => new Map(old).set(turn.run.id, events));
          },
          turn.run.id === focusRunId ? Number.MAX_SAFE_INTEGER : turn.number,
        ),
      structuralSharing: false,
      gcTime: 0,
      refetchInterval:
        !turn.checkpoint && ["running", "queued"].includes(turn.run.status)
          ? 3000
          : (false as const),
    })),
  });
  // useQueries rebuilds its result array every render, so key the merge on a
  // signature of the streamed tails and read their latest data through a ref.
  const tailsRef = useRef(tails);
  tailsRef.current = tails;
  const tailsKey = tails.map((tail) => `${tail.status}:${tail.dataUpdatedAt}`).join("|");
  const mergedCache = useRef(
    new Map<
      string,
      { turn: api.TraceTurn; tail?: api.RunEvent[]; more: boolean; value: api.TraceTurn }
    >(),
  );
  const merged = useMemo(() => {
    void tailsKey;
    return turns.map((turn, index) => {
      const result = tailsRef.current[index];
      const tail = result?.data ?? tailProgress.get(turn.run.id);
      const more = turn.hasMoreEvents && (!result?.data || result.isError);
      const previous = mergedCache.current.get(turn.run.id);
      if (previous?.turn === turn && previous.tail === tail && previous.more === more)
        return previous.value;
      const value =
        !tail || !turn.hasMoreEvents
          ? turn
          : {
              ...turn,
              events: [...new Map([...turn.events, ...tail].map((e) => [e.seq, e])).values()].sort(
                (a, b) => a.seq - b.seq,
              ),
              hasMoreEvents: more,
            };
      mergedCache.current.set(turn.run.id, { turn, tail, more, value });
      return value;
    });
  }, [turns, tailsKey, tailProgress]);
  const records = useMemo(
    () => projector(head.data?.initial ?? null, merged),
    [head.data?.initial, merged, projector],
  );
  const total = head.data?.totalTurns ?? 0;
  const focusLoaded = turns.some((t) => t.run.id === focusRunId);
  const hasOlder = turns.length < total;
  const loadOlder = () =>
    pages && !history.hasNextPage
      ? history.refetch({ cancelRefetch: false })
      : history.fetchNextPage({ cancelRefetch: false });
  const partial = hasOlder || merged.some((t) => t.hasMoreEvents);
  useEffect(() => {
    if (focusRunId && !focusLoaded && hasOlder && !history.isFetching && !history.isError)
      void (pages && !history.hasNextPage ? history.refetch() : history.fetchNextPage());
  }, [
    focusRunId,
    focusLoaded,
    hasOlder,
    history.isFetching,
    history.isError,
    history.fetchNextPage,
    history.refetch,
    history.hasNextPage,
    pages,
  ]);
  const query = {
    ...head,
    error: head.error ?? history.error,
    refetch: head.error ? head.refetch : history.error ? history.refetch : head.refetch,
  };
  const pendingTurns = merged.filter((t) => t.hasMoreEvents);
  const loadedEvents = merged.reduce((n, t) => n + t.events.length, 0);
  // The toolbar chip replaces the old top banner; errors stay as a prominent alert.
  const status =
    loadingAll || partial ? (
      <div className="trace-status-chip" role="status">
        {loadingAll ? (
          <>
            <Spin size="small" />
            <span>{progress || "正在读取全部轮次…"}</span>
            <Button size="small" onClick={() => allController.current?.abort()}>
              取消
            </Button>
          </>
        ) : (
          <>
            <span>
              已加载 {turns.length}/{total} 轮 · {loadedEvents.toLocaleString()} 条事件
              {pendingTurns.length > 0 && ` · ${pendingTurns.length} 轮待补全`}
            </span>
            {tails.some((tail) => tail.isError) && (
              <Button
                size="small"
                onClick={() => {
                  for (const tail of tails) if (tail.isError) void tail.refetch();
                }}
              >
                重试失败轮次
              </Button>
            )}
            <Button size="small" onClick={() => void loadAll()}>
              加载完整会话
            </Button>
          </>
        )}
      </div>
    ) : null;
  return (
    <div className="conversation-trajectory">
      <QueryState
        label="会话轨迹"
        query={query}
        loading={
          <div className="trace-skeleton" role="status" aria-label="加载会话轨迹">
            {Array.from({ length: 8 }, (_, index) => `skeleton-${index}`).map((key) => (
              <div key={key} className="trace-skeleton-row" />
            ))}
          </div>
        }
      >
        {loadError && <Alert className="form-alert" type="warning" title={loadError} />}
        <ConversationTrajectory
          records={records}
          totalTurns={total}
          focusRunId={focusRunId}
          focusRecordId={focusRecordId}
          onSelectRecord={onSelectRecord}
          onExport={() => void loadAll(true)}
          exporting={loadingAll}
          partial={partial}
          hasOlder={hasOlder}
          loadingOlder={history.isFetching}
          onLoadOlder={loadOlder}
          status={status}
          pendingTurns={new Set(pendingTurns.map((t) => t.run.id))}
          onLoadTurn={requestTurn}
          onWindowChange={setVisibleWindow}
        />
        <details className="trace-diagnostics">
          <summary>开发者诊断</summary>
          <p>协议数据用于排错，包含流式分片；Session 日志按消息与调用合并。</p>
          <Button
            size="small"
            onClick={() =>
              downloadTrace("session-protocol.json", {
                complete: !partial,
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

export function ConversationTrace(props: Parameters<typeof ConversationTraceReader>[0]) {
  return <ConversationTraceReader key={`${props.projectId}/${props.conversationId}`} {...props} />;
}
