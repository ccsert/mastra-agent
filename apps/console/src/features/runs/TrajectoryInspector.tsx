import { CloseOutlined } from "@ant-design/icons";
import { Button, Tabs, Tag } from "antd";
import { timestamp } from "../../shared/api";
import { type TraceRecord, traceDuration } from "./trajectory";

export const traceStates = {
  running: "进行中",
  succeeded: "完成",
  failed: "失败",
  interrupted: "未完成",
};
export function traceValue(value: unknown) {
  return value === undefined
    ? "尚未收到"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
}
export function TrajectoryInspector({ record, close }: { record: TraceRecord; close(): void }) {
  const output = record.kind === "model" ? record.text || undefined : record.output;
  const input = record.kind === "tool" ? (record.input ?? (record.text || undefined)) : undefined;
  const timing = (
    <dl className="trace-facts">
      <dt>开始接收</dt>
      <dd>{timestamp(record.startedAt)}</dd>
      <dt>结束接收</dt>
      <dd>{record.finishedAt ? timestamp(record.finishedAt) : "尚未记录"}</dd>
      <dt>接收跨度</dt>
      <dd>{traceDuration(record)}</dd>
      <dt>计时来源</dt>
      <dd>控制面接收事件的时间戳</dd>
    </dl>
  );
  return (
    <section className="trace-inspector" aria-label="轨迹记录详情">
      <header>
        <div>
          <strong>{record.title}</strong>
          <small>
            步骤 {record.step} · {record.id}
          </small>
        </div>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="关闭轨迹检查器"
          onClick={close}
        />
      </header>
      <Tabs
        size="small"
        items={[
          {
            key: "overview",
            label: "概述",
            children: (
              <>
                <Tag>{traceStates[record.status]}</Tag>
                {record.kind === "tool" && (
                  <>
                    <h4>参数</h4>
                    <pre>{traceValue(input)}</pre>
                  </>
                )}
                <h4>{record.status === "failed" ? "错误" : "结果"}</h4>
                <pre>{traceValue(output)}</pre>
                <h4>计时</h4>
                {timing}
              </>
            ),
          },
          ...(record.kind === "tool"
            ? [{ key: "input", label: "参数", children: <pre>{traceValue(input)}</pre> }]
            : []),
          {
            key: "output",
            label: record.status === "failed" ? "错误" : "结果",
            children: <pre>{traceValue(output)}</pre>,
          },
          { key: "timing", label: "计时", children: timing },
          {
            key: "events",
            label: `事件 (${record.events.length})`,
            children: <pre>{JSON.stringify(record.events, null, 2)}</pre>,
          },
        ]}
      />
    </section>
  );
}
