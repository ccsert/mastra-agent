import { RobotOutlined, ToolOutlined, WarningOutlined } from "@ant-design/icons";
import type { Run, RunEvent } from "@platform/sdk";
import { Input, Tag } from "antd";
import { useMemo, useState } from "react";
import { timestamp } from "../../shared/api";
import { projectTrajectory, traceDuration } from "./trajectory";

const states = { running: "进行中", succeeded: "完成", failed: "失败", interrupted: "未完成" };
const colors = {
  running: "processing",
  succeeded: "success",
  failed: "error",
  interrupted: "warning",
};
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
  const [selected, setSelected] = useState<string>(),
    [search, setSearch] = useState("");
  const records = steps.flatMap((s) => s.records),
    current = records.find((r) => r.id === selected);
  return (
    <>
      <div className="trajectory-summary">
        <span>{steps.length} 个步骤</span>
        <span>{records.filter((r) => r.kind === "tool").length} 次工具调用</span>
        <span>{records.filter((r) => r.status === "failed").length} 个错误</span>
      </div>
      <p className="form-note">
        耗时按控制面收到首尾事件的时间计算。未记录的 Token
        用量、模型内部推理和未结束调用的耗时不作推算。
      </p>
      <Input
        aria-label="搜索轨迹"
        placeholder="搜索工具名称或记录类型"
        allowClear
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={current ? "trajectory-layout inspecting" : "trajectory-layout"}>
        <section className="trajectory-steps" aria-label="运行轨迹">
          {!records.length && (
            <p className="muted">
              尚无模型或工具事件。排队、连接失败时可结合运行状态和错误码排查。
            </p>
          )}
          {steps.map((step) => {
            const visible = step.records.filter((r) =>
              r.title.toLowerCase().includes(search.toLowerCase()),
            );
            return visible.length ? (
              <section key={step.number}>
                <h4>步骤 {step.number}</h4>
                {visible.map((record) => (
                  <button
                    type="button"
                    key={record.id}
                    className={current?.id === record.id ? "trace-row selected" : "trace-row"}
                    onClick={() => setSelected(record.id)}
                  >
                    {record.kind === "tool" ? (
                      <ToolOutlined />
                    ) : record.kind === "error" ? (
                      <WarningOutlined />
                    ) : (
                      <RobotOutlined />
                    )}
                    <span>
                      <strong>{record.title}</strong>
                      <small>
                        #{record.events[0]?.seq} · {timestamp(record.startedAt)}
                      </small>
                    </span>
                    <Tag color={colors[record.status]}>{states[record.status]}</Tag>
                    <code>{traceDuration(record)}</code>
                  </button>
                ))}
              </section>
            ) : null;
          })}
        </section>
        {current && (
          <section className="trace-inspector" aria-label="轨迹记录详情">
            <header>
              <strong>{current.title}</strong>
              <button
                type="button"
                aria-label="关闭轨迹检查器"
                onClick={() => setSelected(undefined)}
              >
                ×
              </button>
            </header>
            <p>
              <Tag color={colors[current.status]}>{states[current.status]}</Tag>{" "}
              {traceDuration(current)}
            </p>
            <code className="resource-id">{current.id}</code>
            {current.kind === "tool" && (
              <>
                <h4>输入</h4>
                <pre>
                  {current.input === undefined
                    ? current.text || "尚未收到完整输入"
                    : JSON.stringify(current.input, null, 2)}
                </pre>
                <h4>输出</h4>
                <pre>
                  {current.output === undefined
                    ? "尚未收到输出"
                    : JSON.stringify(current.output, null, 2)}
                </pre>
              </>
            )}
            {current.kind !== "tool" && (
              <pre>
                {current.kind === "error" ? String(current.output) : current.text || "尚无文本输出"}
              </pre>
            )}
            <details>
              <summary>原始事件 · {current.events.length}</summary>
              <pre>{JSON.stringify(current.events, null, 2)}</pre>
            </details>
          </section>
        )}
      </div>
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
