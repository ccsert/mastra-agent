import {
  InfoCircleOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  UserOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { Run, RunEvent } from "@platform/sdk";
import { Button, Input, Splitter } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { timestamp } from "../../shared/api";
import { TrajectoryInspector } from "./TrajectoryInspector";
import {
  projectTrajectory,
  type TraceRecord,
  type TraceRun,
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
const categoryOf = (record: TraceRecord) =>
  ["system", "user", "context"].includes(record.kind)
    ? "输入"
    : record.kind === "tool"
      ? "工具"
      : record.kind === "model"
        ? "模型"
        : "错误";

export function RunTrajectory({
  events,
  status,
  complete,
  run,
}: {
  events: RunEvent[];
  status: Run["status"];
  complete: boolean;
  run?: TraceRun;
}) {
  const steps = useMemo(
    () => projectTrajectory(events, status, complete, run),
    [events, status, complete, run],
  );
  const [selected, setSelected] = useState<string>();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [collapsed, setCollapsed] = useState(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const records = steps.flatMap((s) => s.records);
  const current = records.find((r) => r.id === selected);
  const query = search.trim().toLowerCase();
  useEffect(() => {
    if (selected && !collapsed && !query)
      rows.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected, collapsed, query]);
  const matches = (r: TraceRecord) =>
    (category === "全部" || categoryOf(r) === category) &&
    `${r.title} ${r.text} ${traceValue(r.input)} ${traceValue(r.output)}`
      .toLowerCase()
      .includes(query);
  const visibleSteps = steps
    .map((step) => ({ ...step, records: step.records.filter(matches) }))
    .filter((step) => step.records.length);
  const visibleCount = visibleSteps.reduce(
    (count, step) => count + (!collapsed || query || step.number === 0 ? step.records.length : 0),
    0,
  );
  return (
    <>
      <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <span>
          {steps.filter((s) => s.number > 0).length} 步 ·{" "}
          {records.filter((r) => r.kind === "tool").length} 次工具调用
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
          {collapsed ? "展开步骤" : "收起步骤"}
        </Button>
        <Input
          size="small"
          aria-label="搜索轨迹"
          placeholder="搜索工具、输入或结果"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {!!records.length && (
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
                        aria-label={`定位 ${r.title}`}
                        title={r.title}
                        className={`trace-segment ${r.kind}${r.id === selected ? " selected" : ""}`}
                        onClick={() => {
                          setSelected(r.id);
                          setCollapsed(false);
                          setSearch("");
                          setCategory("全部");
                          rows.current.get(r.id)?.scrollIntoView({ block: "nearest" });
                        }}
                      />
                    ),
                )}
              </div>
            </div>
          ))}
          <small>按事件顺序排列</small>
        </section>
      )}
      <Splitter
        className="trajectory-layout"
        style={{
          height: current
            ? "min(580px, 65dvh)"
            : Math.min(560, Math.max(80, visibleCount * 45 + visibleSteps.length * 30 + 2)),
        }}
      >
        <Splitter.Panel min="30%">
          <section className="trajectory-steps" aria-label="运行轨迹">
            {!records.length && (
              <p className="trace-empty">尚无模型或工具事件。可结合运行状态和错误码排查。</p>
            )}
            {visibleSteps.map((step) => {
              const visible = step.records;
              return (
                <section key={step.number}>
                  <h4>
                    {step.number === 0 ? "初始输入" : `步骤 ${step.number}`}
                    <span>{visible.length} 条记录</span>
                  </h4>
                  {(!collapsed || query || step.number === 0) &&
                    visible.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        ref={(node) => {
                          if (node) rows.current.set(r.id, node);
                          else rows.current.delete(r.id);
                        }}
                        className={`trace-row ${r.kind}${current?.id === r.id ? " selected" : ""}`}
                        aria-label={`${r.title} · ${traceStates[r.status]} · ${traceDuration(r)}`}
                        aria-pressed={current?.id === r.id}
                        onClick={() => setSelected(r.id)}
                      >
                        <span className={`trace-kind ${r.kind}`}>
                          {(() => {
                            const Icon = icons[r.kind];
                            return <Icon />;
                          })()}
                          <small>{traceKinds[r.kind]}</small>
                        </span>
                        <span className="trace-preview">
                          <strong>{r.title}</strong>
                          <span>{tracePreview(r)}</span>
                        </span>
                        <span className={`trace-status ${r.status}`}>{traceStates[r.status]}</span>
                        <code>{traceDuration(r)}</code>
                      </button>
                    ))}
                </section>
              );
            })}
            {!!records.length && !visibleCount && (
              <p className="trace-empty">{collapsed ? "步骤已收起。" : "没有匹配的记录。"}</p>
            )}
          </section>
        </Splitter.Panel>
        {current && (
          <Splitter.Panel defaultSize="44%" min="30%">
            <TrajectoryInspector
              key={current.id}
              record={current}
              close={() => setSelected(undefined)}
            />
          </Splitter.Panel>
        )}
      </Splitter>
      <p className="trajectory-source">
        时间跨度来自控制面接收时间。点选记录查看正文和来源；历史缺失的请求上下文不会补造。
      </p>
      <details className="trace-raw">
        <summary>
          全部原始事件 · {events.length}
          {complete ? "" : "+"}
        </summary>
        <div className="event-list">
          {events.map((e) => (
            <details key={e.seq}>
              <summary>
                <span>#{e.seq}</span>
                <strong>{String(e.chunk.type)}</strong>
                <small>{timestamp(e.createdAt)}</small>
              </summary>
              <pre>{JSON.stringify(e.chunk, null, 2)}</pre>
            </details>
          ))}
        </div>
      </details>
    </>
  );
}
