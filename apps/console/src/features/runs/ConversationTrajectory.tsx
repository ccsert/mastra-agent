import {
  ApartmentOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  UserOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Button, Input, Splitter } from "antd";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TrajectoryInspector } from "./TrajectoryInspector";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import type { TimelineWindow } from "./timeline-window";
import {
  aggregateStatus,
  callGroups,
  foldTrace,
  projectTimeline,
  sessionLog,
  type TraceRecord,
  traceCategories,
  traceCategory,
  traceDuration,
  traceKinds,
  tracePreview,
  traceStates,
  traceValue,
  turnGroups,
  unfoldTarget,
} from "./trajectory";
import { asObject, tokenCount } from "./trajectory-details";

// Only long ledgers window; short ones render every row so search and DOM
// assertions stay simple. Outline rows reserve the same height for title and metadata.
const VIRTUAL_THRESHOLD = 100;
const ROW_HEIGHT = 56;
const OVERSCAN = 12;
const FALLBACK_HEIGHT = 800;

const icons = {
  system: SettingOutlined,
  user: UserOutlined,
  context: InfoCircleOutlined,
  model: RobotOutlined,
  tool: ToolOutlined,
  agent: ApartmentOutlined,
  plan: UnorderedListOutlined,
  error: WarningOutlined,
  run: InfoCircleOutlined,
};
export function downloadTrace(filename: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
export function ConversationTrajectory({
  records,
  totalTurns,
  focusRunId,
  focusRecordId,
  onSelectRecord,
  onExport,
  exporting = false,
  partial = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  status,
  pendingTurns,
  onLoadTurn,
  onWindowChange,
}: {
  records: TraceRecord[];
  totalTurns: number;
  focusRunId?: string;
  focusRecordId?: string;
  onSelectRecord?(recordId: string, runId?: string): void;
  onExport?(): void;
  exporting?: boolean;
  partial?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): Promise<unknown> | unknown;
  /** Compact load-state chip rendered at the toolbar's end instead of a banner. */
  status?: ReactNode;
  /** Turn runs whose events exist but are not loaded yet. */
  pendingTurns?: ReadonlySet<string>;
  onLoadTurn?(runId: string): void;
  onWindowChange?(window: TimelineWindow): void;
}) {
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const active = records.some((r) => r.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  function select(id: string) {
    if (id !== visibleSelection) lastScrolledSelection.current = undefined;
    reveal(unfoldTarget(records, id));
    setSelected(id);
    onSelectRecord?.(id, records.find((r) => r.id === id)?.runId);
  }
  useEffect(() => {
    setSelected(focusRecordId);
  }, [focusRecordId]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"sequence" | "duration">("sequence");
  const list = useRef<HTMLElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const query = search.trim().toLowerCase();
  const order = useMemo(() => new Map(records.map((r, index) => [r.id, index + 1])), [records]);
  // Index search text once per projection instead of stringifying every record on each keystroke.
  const searching = !!query;
  const searchable = useMemo(
    () =>
      new Map(
        (searching ? records : []).map((r) => [
          r.id,
          [
            r.id,
            r.messageId,
            r.runId,
            r.toolCallId,
            r.scopeName,
            r.subagent?.id,
            r.subagent?.task,
            r.requestIndex,
            r.title,
            r.text,
            r.reasoning,
            traceValue(r.input),
            traceValue(r.output),
            traceValue(r.request),
            traceValue(r.tools),
            r.toolsSource,
            r.source,
          ]
            .join(" ")
            .toLowerCase(),
        ]),
      ),
    [records, searching],
  );
  const current = useMemo(
    () =>
      records.find(
        (r) =>
          r.id ===
          (selected ?? records.find((x) => x.runId === focusRunId && x.kind === "user")?.id),
      ),
    [records, selected, focusRunId],
  );
  const filtered = useMemo(
    () =>
      records.filter(
        (r) =>
          (category === "全部" || traceCategory(r) === category) &&
          (!query || (searchable.get(r.id) ?? "").includes(query)),
      ),
    [records, category, query, searchable],
  );
  const visible = useMemo(() => {
    if (!query) return foldTrace(filtered, { turns: collapsedTurns, calls: collapsedCalls });
    const ids = new Set(filtered.flatMap((r) => [r.id, r.parentId]));
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const id of ids) {
      if (!id) continue;
      const parent = byId.get(id)?.parentId;
      if (parent) ids.add(parent);
    }
    const turns = new Set(filtered.map((r) => r.runId));
    return records.filter(
      (r) => ids.has(r.id) || (r.kind === "user" && !r.scopeId && turns.has(r.runId)),
    );
  }, [records, filtered, query, collapsedTurns, collapsedCalls]);
  const visibleSelection = visible.find((r) => r.id === current?.id)?.id;
  const foldableTurns = useMemo(
    () => turnGroups(filtered).filter((group) => group.count > 1),
    [filtered],
  );
  const foldableCalls = useMemo(() => callGroups(filtered), [filtered]);
  const groupedCalls = useMemo(
    () => new Map(callGroups(records).map((g) => [g.id, g.tools])),
    [records],
  );
  const turnStats = useMemo(() => {
    const byRun = new Map<string, TraceRecord[]>();
    for (const record of records) {
      if (!record.runId || !record.turn) continue;
      const group = byRun.get(record.runId) ?? [];
      group.push(record);
      byRun.set(record.runId, group);
    }
    return new Map(
      [...byRun].map(([id, group]) => [
        id,
        {
          requests: group.filter((r) => r.requestIndex !== undefined).length,
          tools: group.filter((r) => r.kind === "tool").length,
          status: aggregateStatus(group),
          failures: group.filter((r) => r.status === "failed").length,
          run: group.find((r) => r.kind === "run" && !r.scopeId),
          subagents: group.filter((r) => r.kind === "agent").length,
          totalTokens: (() => {
            const cost = group.filter(
              (r) =>
                (r.kind === "run" && !r.scopeId) ||
                (r.kind === "agent" && r.subagent?.status !== "rejected"),
            );
            return cost.every((r) => r.usage?.usage.totalTokens != null)
              ? cost.reduce((n, r) => n + (r.usage?.usage.totalTokens ?? 0), 0)
              : null;
          })(),
        },
      ]),
    );
  }, [records]);
  // One jump target per conversation turn; summary turns already carry the question.
  const railTurns = useMemo(() => {
    const byTurn = new Map<
      number,
      { turn: number; runId: string; recordId: string; question: string }
    >();
    for (const record of records) {
      if (record.kind !== "user" || record.turn === undefined || record.scopeId || !record.runId)
        continue;
      if (!byTurn.has(record.turn))
        byTurn.set(record.turn, {
          turn: record.turn,
          runId: record.runId,
          recordId: record.id,
          question: record.text.trim() || "（无文本输入）",
        });
    }
    return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  }, [records]);
  const allTurnsCollapsed =
    foldableTurns.length > 0 && foldableTurns.every((group) => collapsedTurns.has(group.turn));
  const allCallsCollapsed =
    foldableCalls.length > 0 && foldableCalls.every((group) => collapsedCalls.has(group.id));
  function toggleAllTurns() {
    setCollapsedTurns((old) => {
      const next = new Set(old);
      if (allTurnsCollapsed) for (const group of foldableTurns) next.delete(group.turn);
      else for (const group of foldableTurns) next.add(group.turn);
      return next;
    });
  }
  function toggleAllCalls() {
    setCollapsedCalls((old) => {
      const next = new Set(old);
      if (allCallsCollapsed) for (const group of foldableCalls) next.delete(group.id);
      else for (const group of foldableCalls) next.add(group.id);
      return next;
    });
  }
  function expand(summary: NonNullable<TraceRecord["summary"]>) {
    if (summary.kind === "turn" && summary.turn !== undefined) {
      const turn = summary.turn;
      setCollapsedTurns((old) => {
        if (!old.has(turn)) return old;
        const next = new Set(old);
        next.delete(turn);
        return next;
      });
      return;
    }
    if (!summary.call) return;
    const call = summary.call;
    setCollapsedCalls((old) => {
      if (!old.has(call)) return old;
      const next = new Set(old);
      next.delete(call);
      return next;
    });
  }
  const reveal = useCallback((target: ReturnType<typeof unfoldTarget>) => {
    if (target.turn !== undefined) {
      const turn = target.turn;
      setCollapsedTurns((old) => {
        if (!old.has(turn)) return old;
        const next = new Set(old);
        next.delete(turn);
        return next;
      });
    }
    if (target.call) {
      const calls = target.calls ?? [target.call];
      setCollapsedCalls((old) => {
        if (!calls.some((call) => old.has(call))) return old;
        const next = new Set(old);
        for (const call of calls) next.delete(call);
        return next;
      });
    }
  }, []);
  // Restore a deep link when its ancestors arrive, without undoing a manual fold
  // on every polling refresh. Explicit selection also reveals the same record again.
  const selectionPath = JSON.stringify(unfoldTarget(records, selected ?? ""));
  useEffect(() => {
    reveal(JSON.parse(selectionPath));
  }, [selectionPath, reveal]);
  const toolCount = useMemo(() => records.filter((r) => r.kind === "tool").length, [records]);
  const subagentCount = records.filter((r) => r.kind === "agent").length;
  const depths = useMemo(() => {
    const byId = new Map(records.map((r) => [r.id, r]));
    return new Map(
      records.map((r) => {
        const visited = new Set<string>();
        let parent = r.parentId;
        while (parent && !visited.has(parent)) {
          visited.add(parent);
          parent = byId.get(parent)?.parentId;
        }
        return [r.id, visited.size];
      }),
    );
  }, [records]);
  // One positioning pass for the overview; spans are absolute, so no per-record grid tracks.
  const timeline = useMemo(() => projectTimeline(records, mode), [records, mode]);
  const virtual = visible.length > VIRTUAL_THRESHOLD;
  const [viewport, setViewport] = useState({ scrollTop: 0, height: FALLBACK_HEIGHT });
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useEffect(() => {
    const node = list.current;
    if (!virtual || !node) return;
    const update = () =>
      setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || FALLBACK_HEIGHT });
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update());
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [virtual]);
  const scrollTop = Math.min(
    viewport.scrollTop,
    Math.max(0, visible.length * ROW_HEIGHT - viewport.height),
  );
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const end = virtual
    ? Math.min(visible.length, Math.ceil((scrollTop + viewport.height) / ROW_HEIGHT) + OVERSCAN)
    : visible.length;
  async function loadOlder() {
    const node = list.current;
    if (node)
      prependAnchor.current = { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop };
    try {
      await onLoadOlder?.();
    } catch {
      // The owning query already exposes the failure; keep the promise settled here.
    }
  }
  // Keep the reading position when older turns are prepended above the viewport.
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const node = list.current;
    if (!anchor || !node) return;
    prependAnchor.current = null;
    node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight);
    // The prepend itself is the only trigger; the value is intentionally unused.
    void visible.length;
  }, [visible.length]);
  const lastScrolledSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    const node = list.current;
    if (!node || !visibleSelection || lastScrolledSelection.current === visibleSelection) return;
    lastScrolledSelection.current = visibleSelection;
    const index = visible.findIndex((r) => r.id === visibleSelection);
    if (index < 0) return;
    if (virtual) {
      const top = index * ROW_HEIGHT;
      if (top < node.scrollTop || top + ROW_HEIGHT > node.scrollTop + node.clientHeight)
        node.scrollTop = Math.max(0, top - node.clientHeight / 3);
      setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || FALLBACK_HEIGHT });
      return;
    }
    const row = rows.current.get(visibleSelection);
    if (row)
      node.scrollTop = Math.max(
        0,
        node.scrollTop +
          row.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          node.clientHeight / 3,
      );
  }, [visibleSelection, visible, virtual]);
  const renderRow = (r: TraceRecord, index: number) => {
    const summary = r.summary;
    if (summary)
      return (
        <button
          key={r.id}
          type="button"
          style={virtual ? { top: index * ROW_HEIGHT } : undefined}
          className="trace-row summary"
          aria-label={
            summary.kind === "turn"
              ? `展开第 ${summary.turn} 轮 · ${summary.label}`
              : `展开 ${summary.label}`
          }
          onClick={() => expand(summary)}
        >
          <span className="trace-summary-mark" aria-hidden="true">
            ···
          </span>
          <span className="trace-summary-label">
            {summary.kind === "turn" ? `第 ${summary.turn} 轮 · ` : ""}
            {summary.label}
          </span>
          {r.status !== "succeeded" && (
            <span className={`trace-status ${r.status}`}>{traceStates[r.status]}</span>
          )}
        </button>
      );
    const Icon = icons[r.kind];
    const turn = r.runId ? turnStats.get(r.runId) : undefined;
    const isTurn = r.kind === "user" && r.turn !== undefined && !r.scopeId;
    const isRequest = r.requestIndex !== undefined;
    const rowStatus = isTurn ? (turn?.run?.status ?? turn?.status ?? r.status) : r.status;
    const foldable = isTurn || groupedCalls.has(r.id);
    const collapsed = isTurn ? collapsedTurns.has(r.turn ?? 0) : collapsedCalls.has(r.id);
    const usage = r.generation?.usage;
    const detail = r.segment
      ? `${r.events.length} 个事件 · ${r.text.length.toLocaleString()} 字符`
      : isRequest
        ? `${String(asObject(r.request).model ?? "模型")} · ${usage?.inputTokens == null ? "输入未报告" : `${tokenCount(usage.inputTokens)} 输入`} / ${usage?.outputTokens == null ? "输出未报告" : `${tokenCount(usage.outputTokens)} 输出`}${r.generation?.finishReason ? ` · ${r.generation.finishReason}` : ""}`
        : isTurn
          ? `${turn?.requests ?? 0} 次请求 · ${turn?.tools ?? 0} 次工具调用${turn?.subagents ? ` · ${turn.subagents} 个子任务` : ""}${turn?.run ? ` · ${traceDuration(turn.run)}` : ""}${turn?.totalTokens != null ? ` · ${tokenCount(turn.totalTokens)} Token${turn.subagents ? "（含子任务）" : ""}` : ""}${r.runId && pendingTurns?.has(r.runId) ? " · 明细未加载" : ""}`
          : r.kind === "agent"
            ? `${r.subagent?.status === "queued" ? "等待执行" : "独立子任务"} · 最多 ${r.subagent?.maxSteps} 步 · ${r.usage?.usage.totalTokens == null ? "用量待报告" : `${tokenCount(r.usage.usage.totalTokens)} Token`}`
            : r.kind === "tool"
              ? `${r.toolTiming?.source ?? "工具"}${r.toolCallId ? ` · ${r.toolCallId}` : ""}`
              : "";
    return (
      <div
        key={r.id}
        style={{
          ...(virtual ? { top: index * ROW_HEIGHT } : {}),
          paddingLeft: 8 + (depths.get(r.id) ?? 0) * 16,
        }}
        className={`trace-row ${r.kind}${isTurn ? " turn-header" : ""}${isRequest ? " request-header" : ""}${r.parentId ? " child-record" : ""}${r.segment ? ` ${r.segment}` : ""}${current?.id === r.id ? " selected" : ""}`}
      >
        <span className="trace-fold-slot">
          {foldable && (
            <button
              type="button"
              className="trace-fold-toggle"
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? "展开" : "收起"}${isTurn ? `第 ${r.turn} 轮` : `${r.title}${r.scopeName ? ` · ${r.scopeName}` : ""}明细`}`}
              onClick={() => {
                if (isTurn)
                  setCollapsedTurns((old) => {
                    const next = new Set(old);
                    if (next.has(r.turn ?? 0)) next.delete(r.turn ?? 0);
                    else next.add(r.turn ?? 0);
                    return next;
                  });
                else
                  setCollapsedCalls((old) => {
                    const next = new Set(old);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  });
              }}
            >
              {collapsed ? "▸" : "▾"}
            </button>
          )}
          {r.parentId && (
            <span aria-hidden="true" className="trace-tree-edge">
              └
            </span>
          )}
        </span>
        <button
          type="button"
          ref={
            virtual
              ? undefined
              : (node) => {
                  if (node) rows.current.set(r.id, node);
                  else rows.current.delete(r.id);
                }
          }
          className="trace-row-select"
          aria-label={`${r.title}${r.scopeName ? ` · ${r.scopeName}` : ""}${r.turn ? ` · 第 ${r.turn} 轮` : ""} · ${traceStates[r.status]}`}
          aria-pressed={current?.id === r.id}
          onClick={() => select(r.id)}
        >
          <span className="trace-index" aria-hidden="true">
            {order.get(r.id)}
          </span>
          <span className={`trace-kind ${r.kind}`}>
            <Icon />
            <small>
              {r.segment === "reasoning"
                ? "推理"
                : r.segment === "text"
                  ? "正文"
                  : isRequest
                    ? "请求"
                    : traceKinds[r.kind]}
            </small>
          </span>
          <span className="trace-preview">
            <span className="trace-row-headline">
              <strong>{isTurn ? `第 ${r.turn} 轮` : r.title}</strong>
              <span>
                {isRequest
                  ? `${r.childIds?.length ?? 0} 条明细 · ${r.toolCalls?.length ?? 0} 次工具调用`
                  : tracePreview(r)}
              </span>
            </span>
            {detail && <small className="trace-row-detail">{detail}</small>}
          </span>
          {rowStatus !== "succeeded" && (
            <span className={`trace-status ${rowStatus}`}>{traceStates[rowStatus]}</span>
          )}
          {isTurn && !!turn?.failures && (
            <span className="trace-status failed">{turn.failures} 处失败</span>
          )}
          <code>{traceDuration(r, now)}</code>
        </button>
        {isTurn && r.runId && pendingTurns?.has(r.runId) && (
          <Button
            size="small"
            className="trace-row-load"
            onClick={() => {
              if (r.runId) onLoadTurn?.(r.runId);
            }}
          >
            载入明细
          </Button>
        )}
      </div>
    );
  };
  return (
    <section className="session-trajectory" aria-label="会话轨迹">
      <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <span>
          {totalTurns} 轮 · {toolCount}
          {partial ? "+" : ""} 次工具调用
          {subagentCount > 0 && ` · ${subagentCount} 个子任务`}
          {records.some((r) => r.taskPlan) &&
            ` · ${records.filter((r) => r.taskPlan).length} 次计划更新`}
        </span>
        <fieldset className="trace-filters" aria-label="事件分类">
          {["全部", ...traceCategories].map((value) => (
            <Button
              key={value}
              size="small"
              type={category === value ? "primary" : "text"}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {value}
            </Button>
          ))}
        </fieldset>
        <Button size="small" type="text" disabled={!foldableTurns.length} onClick={toggleAllTurns}>
          {allTurnsCollapsed ? "展开轮次" : "收起轮次"}
        </Button>
        <Button size="small" type="text" disabled={!foldableCalls.length} onClick={toggleAllCalls}>
          {allCallsCollapsed ? "展开调用" : "收起调用"}
        </Button>
        <Button
          size="small"
          type="text"
          aria-pressed={mode === "duration"}
          onClick={() => setMode(mode === "sequence" ? "duration" : "sequence")}
        >
          {mode === "sequence" ? "按实际时长" : "按顺序"}
        </Button>
        <Input
          size="small"
          aria-label="搜索轨迹"
          placeholder="搜索消息、推理、请求、工具或 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Button
          size="small"
          loading={exporting}
          onClick={() =>
            onExport
              ? onExport()
              : downloadTrace("session-log.json", {
                  complete: !partial,
                  records: sessionLog(records),
                })
          }
        >
          导出完整会话
        </Button>
        {status}
      </div>
      <TrajectoryTimeline
        key={mode}
        timeline={timeline}
        mode={mode}
        selected={current?.id}
        onSelect={(id) => {
          select(id);
          setSearch("");
          setCategory("全部");
        }}
        onWindowChange={onWindowChange}
      />
      <Splitter className="trajectory-layout">
        <Splitter.Panel min="30%">
          <div className="trajectory-body">
            {railTurns.length > 0 && (
              <nav className="trace-rail" aria-label="按提问跳转轮次">
                {railTurns.map((item) => (
                  <button
                    key={item.runId}
                    type="button"
                    className={`trace-rail-item${current?.turn === item.turn ? " active" : ""}`}
                    title={item.question}
                    onClick={() => {
                      onLoadTurn?.(item.runId);
                      select(item.recordId);
                    }}
                  >
                    <span className="trace-rail-turn">
                      第 {item.turn} 轮
                      {pendingTurns?.has(item.runId) && (
                        <i className="trace-rail-pending" title="明细未加载" />
                      )}
                    </span>
                    <span className="trace-rail-question">{item.question}</span>
                  </button>
                ))}
              </nav>
            )}
            <section className="trajectory-records" ref={list} aria-label="多轮消息与调用">
              {hasOlder && (
                <div className="trace-history-load">
                  <Button size="small" loading={loadingOlder} onClick={() => void loadOlder()}>
                    加载更早轮次
                  </Button>
                </div>
              )}
              {virtual ? (
                <div
                  className="trace-virtual-canvas"
                  style={{ height: visible.length * ROW_HEIGHT }}
                >
                  {visible.slice(start, end).map((r, offset) => renderRow(r, start + offset))}
                </div>
              ) : (
                visible.map((r, index) => renderRow(r, index))
              )}
              {!visible.length && (
                <p className="trace-empty">
                  {records.length ? "没有匹配的记录。" : "此会话尚无运行记录。"}
                </p>
              )}
            </section>
          </div>
        </Splitter.Panel>
        {current && (
          <Splitter.Panel defaultSize="48%" min="30%">
            <TrajectoryInspector
              key={current.id}
              record={current}
              records={records}
              close={() => select("")}
              onLocate={(id) => {
                select(id);
                setSearch("");
                setCategory("全部");
              }}
              previous={records[records.findIndex((r) => r.id === current.id) - 1]?.id}
              next={records[records.findIndex((r) => r.id === current.id) + 1]?.id}
            />
          </Splitter.Panel>
        )}
      </Splitter>
      <p className="trajectory-source">
        {query ? `匹配 ${filtered.length} 条记录 · ` : ""}按调用顺序排列 · 计时来源见详情
        {partial
          ? " · 搜索覆盖已加载内容；完整导出会读取全部轮次和后续事件"
          : " · 已加载全部已记录内容"}
      </p>
    </section>
  );
}
