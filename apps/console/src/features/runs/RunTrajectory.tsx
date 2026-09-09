import { RobotOutlined, ToolOutlined, WarningOutlined } from "@ant-design/icons";
import type { Run, RunEvent } from "@platform/sdk";
import { Button, Input, Splitter } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { timestamp } from "../../shared/api";
import { TrajectoryInspector, traceStates, traceValue } from "./TrajectoryInspector";
import { projectTrajectory, traceDuration } from "./trajectory";

export function RunTrajectory({
  events,
  status,
  complete,
}: {
  events: RunEvent[];
  status: Run["status"];
  complete: boolean;
}) {
  const steps = useMemo(
    () => projectTrajectory(events, status, complete),
    [events, status, complete],
  );
  const [selected, setSelected] = useState<string>();
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const records = steps.flatMap((s) => s.records);
  const current = records.find((r) => r.id === selected);
  const query = search.trim().toLowerCase();
  useEffect(() => {
    if (selected && !collapsed && !query)
      rows.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected, collapsed, query]);
  return (
    <>
      <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <span>
          {steps.length} 步 · {records.filter((r) => r.kind === "tool").length} 次工具调用
        </span>
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
        <section className="trajectory-overview" aria-label="调用顺序概览">
          <small>调用顺序</small>
          <div>
            {records.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-label={`定位 ${r.title}`}
                title={`步骤 ${r.step} · ${r.title}`}
                className={`trace-segment ${r.kind}${r.id === selected ? " selected" : ""}`}
                onClick={() => {
                  setSelected(r.id);
                  setCollapsed(false);
                  setSearch("");
                  rows.current.get(r.id)?.scrollIntoView({ block: "nearest" });
                }}
              />
            ))}
          </div>
        </section>
      )}
      <Splitter className="trajectory-layout">
        <Splitter.Panel min="30%">
          <section className="trajectory-steps" aria-label="运行轨迹">
            {!records.length && (
              <p className="trace-empty">尚无模型或工具事件。可结合运行状态和错误码排查。</p>
            )}
            {steps.map((step) => {
              const visible = step.records.filter((r) =>
                `${r.title} ${r.text} ${traceValue(r.input)} ${traceValue(r.output)}`
                  .toLowerCase()
                  .includes(query),
              );
              if (!visible.length) return null;
              return (
                <section key={step.number}>
                  <h4>
                    步骤 {step.number}
                    <span>{visible.length} 条记录</span>
                  </h4>
                  {(!collapsed || query) &&
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
                        <span
                          className="trace-kind"
                          title={r.kind === "tool" ? "工具" : r.kind === "error" ? "错误" : "模型"}
                        >
                          {r.kind === "tool" ? (
                            <ToolOutlined />
                          ) : r.kind === "error" ? (
                            <WarningOutlined />
                          ) : (
                            <RobotOutlined />
                          )}
                        </span>
                        <span className="trace-preview">
                          <strong>{r.title}</strong>
                          <span>
                            {r.kind === "tool"
                              ? `${traceValue(r.input)} → ${traceValue(r.output)}`
                              : r.text || traceValue(r.output)}
                          </span>
                        </span>
                        <span className={`trace-status ${r.status}`}>{traceStates[r.status]}</span>
                        <code>{traceDuration(r)}</code>
                      </button>
                    ))}
                </section>
              );
            })}
            {!!records.length &&
              query &&
              !records.some((r) =>
                `${r.title} ${r.text} ${traceValue(r.input)} ${traceValue(r.output)}`
                  .toLowerCase()
                  .includes(query),
              ) && <p className="trace-empty">没有匹配的记录。</p>}
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
        跨度来自控制面接收时间；概览按事件顺序排列。模型原生耗时、Token 用量与请求上下文尚未采集。
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
