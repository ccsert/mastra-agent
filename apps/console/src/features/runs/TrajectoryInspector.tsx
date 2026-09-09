import { CloseOutlined } from "@ant-design/icons";
import { Button, Tabs, Tag } from "antd";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { timestamp } from "../../shared/api";
import { type TraceRecord, traceDuration, traceKinds, traceStates, traceValue } from "./trajectory";

export function TrajectoryInspector({ record, close }: { record: TraceRecord; close(): void }) {
  const message = ["system", "user", "model"].includes(record.kind);
  const output = message ? record.text : record.kind === "context" ? record.input : record.output;
  const input = record.input ?? (record.text || undefined);
  const plain = (value: unknown) => <pre>{traceValue(value).replace(/^(?:[ \t]*\r?\n)+/, "")}</pre>;
  const content =
    record.kind === "model" ? (
      record.text.trim() ? (
        <div className="trace-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {record.text}
          </Markdown>
        </div>
      ) : (
        <p className="trace-empty">模型未返回正文</p>
      )
    ) : (
      plain(output)
    );
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
            {record.step === 0 ? "初始输入" : `步骤 ${record.step}`} · {record.id}
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
      <p className="trace-provenance">
        <Tag>{traceKinds[record.kind]}</Tag>
        {record.source ?? "已持久化执行事件"}
      </p>
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
                    {plain(input)}
                  </>
                )}
                <h4>
                  {message
                    ? "正文"
                    : record.kind === "context"
                      ? "请求正文"
                      : record.status === "failed"
                        ? "错误"
                        : "结果"}
                </h4>
                {content}
              </>
            ),
          },
          ...(record.kind === "tool"
            ? [{ key: "input", label: "参数", children: plain(input) }]
            : []),
          {
            key: "output",
            label: message
              ? "原始正文"
              : record.kind === "context"
                ? "请求正文"
                : record.status === "failed"
                  ? "错误"
                  : "结果",
            children: <pre>{traceValue(output)}</pre>,
          },
          ...(["tool", "model", "error"].includes(record.kind)
            ? [{ key: "timing", label: "计时", children: timing }]
            : []),
          ...(record.events.length
            ? [
                {
                  key: "events",
                  label: `事件 (${record.events.length})`,
                  children: plain(record.events),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
