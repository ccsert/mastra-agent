import {
  InfoCircleOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  UserOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Button, Input, Splitter } from "antd";
import { useEffect, useRef, useState } from "react";
import { TrajectoryInspector } from "./TrajectoryInspector";
import {
  sessionLog,
  type TraceRecord,
  traceDuration,
  traceKinds,
  tracePreview,
  traceStates,
  traceValue,
} from "./trajectory";

const icons = {
  system: SettingOutlined,
  user: UserOutlined,
  context: InfoCircleOutlined,
  model: RobotOutlined,
  tool: ToolOutlined,
  error: WarningOutlined,
};
const categoryOf = (r: TraceRecord) =>
  ["system", "user", "context"].includes(r.kind)
    ? "输入"
    : r.kind === "tool"
      ? "工具"
      : r.kind === "model"
        ? "模型"
        : "错误";
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
  partial = false,
}: {
  records: TraceRecord[];
  totalTurns: number;
  focusRunId?: string;
  partial?: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [collapsed, setCollapsed] = useState(false);
  const list = useRef<HTMLElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const current = records.find(
    (r) =>
      r.id === (selected ?? records.find((r) => r.runId === focusRunId && r.kind === "user")?.id),
  );
  const query = search.trim().toLowerCase();
  const visible = records.filter(
    (r) =>
      (category === "全部" || categoryOf(r) === category) &&
      (!collapsed || query || r.kind === "system" || r.kind === "user") &&
      `${r.title} ${r.text} ${traceValue(r.input)} ${traceValue(r.output)}`
        .toLowerCase()
        .includes(query),
  );
  const visibleSelection = visible.find((r) => r.id === current?.id)?.id;
  useEffect(() => {
    const node = visibleSelection && rows.current.get(visibleSelection);
    if (node && list.current)
      list.current.scrollTop = Math.max(0, node.offsetTop - list.current.clientHeight / 3);
  }, [visibleSelection]);
  return (
    <section className="session-trajectory" aria-label="会话轨迹">
      <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <span>
          {totalTurns} 轮 · {records.filter((r) => r.kind === "tool").length}
          {partial ? "+" : ""} 次工具调用
        </span>
        <fieldset className="trace-filters" aria-label="事件分类">
          {["全部", "输入", "模型", "工具"].map((value) => (
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
        <Button size="small" type="text" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? "展开轮次" : "收起轮次"}
        </Button>
        <Input
          size="small"
          aria-label="搜索轨迹"
          placeholder="搜索消息、工具或结果"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Button
          size="small"
          onClick={() =>
            downloadTrace("session-log.json", { complete: !partial, records: sessionLog(records) })
          }
        >
          Session 日志
        </Button>
      </div>
      <section className="trajectory-overview" aria-label="分类调用顺序概览">
        {["输入", "模型", "工具"].map((lane) => (
          <div className="trace-lane" key={lane}>
            <span>{lane}</span>
            <div
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, records.length)}, minmax(0, 1fr))`,
              }}
            >
              {records.map(
                (r, index) =>
                  categoryOf(r) === lane && (
                    <button
                      key={r.id}
                      type="button"
                      style={{ gridColumn: index + 1 }}
                      aria-label={`定位 ${r.title}${r.turn ? ` · 第 ${r.turn} 轮` : ""}`}
                      title={`${r.turn ? `第 ${r.turn} 轮 · ` : ""}${r.title}`}
                      className={`trace-segment ${r.kind}${current?.id === r.id ? " selected" : ""}`}
                      onClick={() => {
                        setSelected(r.id);
                        setSearch("");
                        setCategory("全部");
                        setCollapsed(false);
                      }}
                    />
                  ),
              )}
            </div>
          </div>
        ))}
      </section>
      <Splitter className="trajectory-layout">
        <Splitter.Panel min="30%">
          <section className="trajectory-records" ref={list} aria-label="多轮消息与调用">
            {visible.map((r) => {
              const Icon = icons[r.kind];
              return (
                <button
                  key={r.id}
                  type="button"
                  ref={(node) => {
                    if (node) rows.current.set(r.id, node);
                    else rows.current.delete(r.id);
                  }}
                  className={`trace-row ${r.kind}${current?.id === r.id ? " selected" : ""}`}
                  aria-label={`${r.title}${r.turn ? ` · 第 ${r.turn} 轮` : ""} · ${traceStates[r.status]}`}
                  aria-pressed={current?.id === r.id}
                  onClick={() => setSelected(r.id)}
                >
                  <span className="trace-round">{r.kind === "user" ? `第 ${r.turn} 轮` : ""}</span>
                  <span className={`trace-kind ${r.kind}`}>
                    <Icon />
                    <small>{traceKinds[r.kind]}</small>
                  </span>
                  <span className="trace-preview">
                    {!["user", "model"].includes(r.kind) && <strong>{r.title}</strong>}
                    <span>{tracePreview(r)}</span>
                  </span>
                  {r.status !== "succeeded" && (
                    <span className={`trace-status ${r.status}`}>{traceStates[r.status]}</span>
                  )}
                  <code>{traceDuration(r)}</code>
                </button>
              );
            })}
            {!visible.length && (
              <p className="trace-empty">
                {records.length ? "没有匹配的记录。" : "此会话尚无运行记录。"}
              </p>
            )}
          </section>
        </Splitter.Panel>
        {current && (
          <Splitter.Panel defaultSize="48%" min="30%">
            <TrajectoryInspector key={current.id} record={current} close={() => setSelected("")} />
          </Splitter.Panel>
        )}
      </Splitter>
      <p className="trajectory-source">
        按调用顺序排列 · 时长来自事件接收时间
        {partial ? " · 部分轮次或调用尚未加载，导出包含已加载内容" : ""}
      </p>
    </section>
  );
}
