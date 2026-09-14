import {
  AimOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { Button, Tabs, Tag, Tooltip } from "antd";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolResult } from "../../shared/ai/ToolResult";
import { timestamp } from "../../shared/api";
import { RunStatus } from "./RunStatus";
import {
  GenerationUsage,
  PlanOverview,
  RequestOverview,
  SubagentOverview,
  ToolOverview,
  TraceValue,
} from "./TrajectoryDetails";
import {
  sessionLog,
  type TraceRecord,
  timingSource,
  traceDuration,
  traceKinds,
  traceValue,
} from "./trajectory";
import { contextChange } from "./trajectory-details";

function plain(value: unknown) {
  return <pre>{traceValue(value).replace(/^(?:[ \t]*\r?\n)+/, "")}</pre>;
}
function Tools({ record }: { record: TraceRecord }) {
  return (
    <div className="trace-tools">
      <p className="trace-provenance">{record.toolsSource}</p>
      {record.tools?.length ? (
        record.tools.map((tool) => (
          <details key={tool.name}>
            <summary>
              <code>{tool.name}</code>
              <span>{tool.description || "未提供说明"}</span>
            </summary>
            {tool.inputSchema ? (
              <>
                <h4>参数定义</h4>
                {plain(tool.inputSchema)}
              </>
            ) : (
              <p className="trace-empty">此历史运行未保存工具定义，不能用当前定义替代。</p>
            )}
          </details>
        ))
      ) : (
        <p className="trace-empty">
          {record.toolsSource?.includes("历史")
            ? "未保存历史 Runtime 工具定义。"
            : "本次未注册工具。"}
        </p>
      )}
    </div>
  );
}
function Request({
  record,
  previous,
  records,
  onLocate,
}: {
  record: TraceRecord;
  previous?: TraceRecord;
  records: TraceRecord[];
  onLocate?(id: string): void;
}) {
  const value = record.request;
  if (!value || typeof value !== "object" || Array.isArray(value)) return plain(value);
  const change = contextChange(record, previous);
  const request = value as Record<string, unknown>;
  const { messages, tools, ...settings } = request;
  return (
    <div className="trace-request">
      <h4>模型与参数</h4>
      {plain(settings)}
      <h4>实际发送的消息（含本轮之前的上下文）</h4>
      <p className="trace-provenance">
        {change.comparable
          ? `与上次请求相比，前 ${change.shared} 条消息相同；其后 ${change.added} 条为本次新增或变更。`
          : "首次加载的请求；以下是当时实际发送的完整消息。"}
      </p>
      {Array.isArray(messages)
        ? messages.map((value, index) => {
            const message =
              value && typeof value === "object" ? (value as Record<string, unknown>) : {};
            const origin =
              typeof message.tool_call_id === "string"
                ? records
                    .slice(
                      0,
                      records.findIndex((r) => r.id === record.id),
                    )
                    .findLast(
                      (r) => r.toolCallId === message.tool_call_id && r.scopeId === record.scopeId,
                    )
                : undefined;
            return (
              <details
                // biome-ignore lint/suspicious/noArrayIndexKey: Captured message positions are immutable protocol identities.
                key={index}
                className="trace-context-message"
                open={change.comparable && index >= change.shared}
              >
                <summary>
                  <code>
                    #{index + 1} · {String(message.role ?? "未知角色")}
                  </code>
                  {change.comparable && <em>{index < change.shared ? "沿用" : "新增 / 变更"}</em>}
                  <span>{String(message.name ?? message.tool_call_id ?? "")}</span>
                  <span className="trace-context-preview">
                    {typeof message.content === "string"
                      ? message.content.slice(0, 160)
                      : "结构化内容"}
                  </span>
                </summary>
                {plain(message.content)}
                {origin && (
                  <button
                    type="button"
                    className="trace-inline-action"
                    onClick={() => onLocate?.(origin.id)}
                  >
                    定位原工具结果 · {origin.title} · 第 {origin.turn} 轮 →
                  </button>
                )}
                {message.tool_calls ? (
                  <>
                    <h4>工具调用</h4>
                    {plain(message.tool_calls)}
                  </>
                ) : null}
              </details>
            );
          })
        : plain(messages)}
      <details>
        <summary>完整请求 JSON（含工具定义）</summary>
        {plain(request)}
      </details>
    </div>
  );
}

function Usage({ record, records }: { record: TraceRecord; records: TraceRecord[] }) {
  const usage = record.usage;
  if (!usage) return null;
  const value = (n: number | null) => (n === null ? "未报告" : n.toLocaleString());
  const delegated =
    record.kind === "run" && !record.scopeId
      ? records.filter((r) => r.runId === record.runId && r.kind === "agent")
      : [];
  return (
    <>
      <p className="trace-provenance">模型供应方报告的累计用量；未报告字段不会按 0 计算。</p>
      {delegated.length > 0 && (
        <p className="trace-provenance">
          以下为主代理用量。{delegated.length} 个子任务另外统计，避免混淆或重复计算。
        </p>
      )}
      <dl className="trace-facts">
        <dt>输入 Token</dt>
        <dd>{value(usage.usage.inputTokens)}</dd>
        <dt>输出 Token</dt>
        <dd>{value(usage.usage.outputTokens)}</dd>
        <dt>总 Token</dt>
        <dd>{value(usage.usage.totalTokens)}</dd>
        <dt>推理 Token</dt>
        <dd>{value(usage.usage.reasoningTokens)}</dd>
        <dt>缓存命中</dt>
        <dd>{value(usage.usage.cachedInputTokens)}</dd>
        <dt>结束原因</dt>
        <dd>{usage.finishReason ?? "未报告"}</dd>
      </dl>
      {delegated.map((child) => (
        <p key={child.id}>
          {child.title} · {value(child.usage?.usage.totalTokens ?? null)} Token
        </p>
      ))}
      <h4>逐次模型生成（不含单独的网络重试）</h4>
      {usage.perStep.map((step) => (
        <details key={step.stepIndex}>
          <summary>
            生成 #{step.stepIndex + 1} · {step.modelId ?? "模型未报告"} ·{" "}
            {value(step.usage.totalTokens)} Token
          </summary>
          {plain(step)}
        </details>
      ))}
    </>
  );
}

export function TrajectoryInspector({
  record,
  close,
  onLocate,
  previous,
  next,
  records = [],
}: {
  record: TraceRecord;
  close(): void;
  onLocate?(id: string): void;
  previous?: string;
  next?: string;
  records?: TraceRecord[];
}) {
  const [copied, setCopied] = useState("");
  const message = ["system", "user", "model"].includes(record.kind);
  const children = records.filter((r) => r.parentId === record.id);
  const parent = records.find((r) => r.id === record.parentId);
  const previousRequest = records
    .slice(
      0,
      records.findIndex((r) => r.id === record.id),
    )
    .findLast(
      (r) =>
        r.requestIndex !== undefined && !r.segment && r.request && r.scopeId === record.scopeId,
    );
  const output = message ? record.text : record.kind === "context" ? record.input : record.output;
  const savedParts =
    output && typeof output === "object" && "parts" in output && Array.isArray(output.parts)
      ? output.parts
      : [];
  const savedText = savedParts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  const markdown = (text: string) => (
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
        {text}
      </Markdown>
    </div>
  );
  const content =
    record.kind === "model" ? (
      record.text.trim() ? (
        markdown(record.text)
      ) : (
        <p className="trace-empty">
          {record.status === "failed"
            ? "模型请求失败，未收到正文。"
            : record.reasoning
              ? "本条只记录了推理内容，请查看推理标签。"
              : "模型未返回正文"}
        </p>
      )
    ) : record.kind === "tool" ? (
      <ToolResult toolName={record.title} result={output} />
    ) : record.kind === "run" ? (
      <>
        <p>{record.text}</p>
        <p className="trace-provenance">
          {record.coverage?.length ? record.coverage.join("；") : "已记录请求、计时与用量。"}
        </p>
        <h4>已保存的最终消息</h4>
        {savedText ? markdown(savedText) : plain(output)}
        {savedParts.length > 0 && (
          <details>
            <summary>完整消息（含推理与工具结果）</summary>
            {plain(output)}
          </details>
        )}
      </>
    ) : (
      plain(output)
    );
  return (
    <section className="trace-inspector" aria-label="轨迹记录详情">
      <header>
        <div>
          <strong>{record.title}</strong>
          <small>
            {record.turn ? `第 ${record.turn} 轮` : "会话初始配置"} · {timestamp(record.startedAt)}
            {record.scopeName && ` · 子代理：${record.scopeName}`}
          </small>
        </div>
        <div className="trace-inspector-header-actions">
          <div className="trace-inspector-actions">
            <Tooltip title="上一条记录">
              <Button
                size="small"
                type="text"
                icon={<ArrowUpOutlined />}
                aria-label="上一条记录"
                disabled={!previous}
                onClick={() => previous && onLocate?.(previous)}
              />
            </Tooltip>
            <Tooltip title="下一条记录">
              <Button
                size="small"
                type="text"
                icon={<ArrowDownOutlined />}
                aria-label="下一条记录"
                disabled={!next}
                onClick={() => next && onLocate?.(next)}
              />
            </Tooltip>
          </div>
          <Tooltip title="关闭详情">
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label="关闭轨迹检查器"
              onClick={close}
            />
          </Tooltip>
        </div>
      </header>
      <p className="trace-provenance">
        <Tag>{traceKinds[record.kind]}</Tag>
        {record.source ?? "已持久化的调用记录"}
      </p>
      <div className="trace-inspector-actions">
        {record.parentId && (
          <Tooltip
            title={parent?.kind === "agent" ? "跳转到所属子代理记录" : "跳转到所属模型请求记录"}
          >
            <Button
              size="small"
              type="text"
              icon={<AimOutlined />}
              onClick={() => onLocate?.(record.parentId ?? "")}
            >
              {parent?.kind === "agent" ? "返回子代理" : "定位模型请求"}
            </Button>
          </Tooltip>
        )}
        <Tooltip title="复制这条记录的结构化 JSON">
          <Button
            size="small"
            type="text"
            icon={copied === "已复制" ? <CheckOutlined /> : <CopyOutlined />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  JSON.stringify(sessionLog([record])[0], null, 2),
                );
                setCopied("已复制");
              } catch {
                setCopied("复制失败，请使用完整导出");
              }
            }}
          >
            {copied || "复制记录"}
          </Button>
        </Tooltip>
      </div>
      <Tabs
        size="small"
        items={[
          ...(record.requestIndex !== undefined || ["tool", "agent", "plan"].includes(record.kind)
            ? [
                {
                  key: "overview",
                  label: "概览",
                  children:
                    record.kind === "plan" ? (
                      <PlanOverview record={record} records={records} onLocate={onLocate} />
                    ) : record.kind === "agent" ? (
                      <SubagentOverview record={record} details={children} onLocate={onLocate} />
                    ) : record.kind === "tool" ? (
                      <ToolOverview record={record} parent={parent} onLocate={onLocate} />
                    ) : (
                      <RequestOverview
                        record={record}
                        previous={previousRequest}
                        details={children}
                        onLocate={onLocate}
                      />
                    ),
                },
              ]
            : []),
          {
            key: "content",
            label:
              record.kind === "system"
                ? "系统提示词"
                : record.kind === "tool"
                  ? "结果"
                  : record.kind === "context"
                    ? "请求内容"
                    : record.kind === "run"
                      ? "概览"
                      : "内容",
            children: content,
          },
          ...(record.reasoning && !record.segment
            ? [{ key: "reasoning", label: "推理", children: markdown(record.reasoning) }]
            : []),
          ...(record.request
            ? [
                {
                  key: "request",
                  label: "请求内容",
                  children: (
                    <Request
                      record={record}
                      previous={previousRequest}
                      records={records}
                      onLocate={onLocate}
                    />
                  ),
                },
              ]
            : []),
          ...(record.execution
            ? [
                {
                  key: "execution",
                  label: "本轮运行",
                  children: (
                    <dl className="trace-facts">
                      <dt>状态</dt>
                      <dd>
                        <RunStatus status={record.execution.status} />
                      </dd>
                      <dt>运行 ID</dt>
                      <dd>{record.execution.id}</dd>
                      <dt>发布版本</dt>
                      <dd>
                        {record.execution.releaseVersion === 0
                          ? "草稿试用"
                          : `v${record.execution.releaseVersion}`}
                      </dd>
                      <dt>Runtime</dt>
                      <dd>{record.execution.runtimeId}</dd>
                      <dt>指定 Skills</dt>
                      <dd>
                        {record.execution.selectedSkills
                          ?.map((s) => `${s.name} · v${s.version}`)
                          .join("、") || "未指定"}
                      </dd>
                    </dl>
                  ),
                },
              ]
            : []),
          ...(record.kind === "tool"
            ? [
                {
                  key: "input",
                  label: "参数",
                  children: <TraceValue name="参数" value={record.input ?? record.text} />,
                },
              ]
            : []),
          ...(record.tools
            ? [
                {
                  key: "tools",
                  label: `工具 (${record.tools.length})`,
                  children: <Tools record={record} />,
                },
              ]
            : []),
          ...(record.usage
            ? [
                {
                  key: "usage",
                  label: "用量",
                  children: <Usage record={record} records={records} />,
                },
              ]
            : record.requestIndex !== undefined
              ? [{ key: "usage", label: "用量", children: <GenerationUsage record={record} /> }]
              : []),
          ...(["tool", "model", "agent", "error", "run"].includes(record.kind)
            ? [
                {
                  key: "timing",
                  label: "计时",
                  children: (
                    <dl className="trace-facts">
                      <dt>开始</dt>
                      <dd>{timestamp(record.startedAt)}</dd>
                      <dt>结束</dt>
                      <dd>{record.finishedAt ? timestamp(record.finishedAt) : "尚未记录"}</dd>
                      <dt>耗时</dt>
                      <dd>{traceDuration(record)}</dd>
                      <dt>计时来源</dt>
                      <dd>{timingSource(record)}</dd>
                      {record.modelTiming && (
                        <>
                          <dt>HTTP 状态</dt>
                          <dd>{record.modelTiming.httpStatus ?? "未收到响应"}</dd>
                          <dt>首字节</dt>
                          <dd>
                            {record.modelTiming.firstByteMs === null
                              ? "未收到"
                              : `${record.modelTiming.firstByteMs} ms`}
                          </dd>
                          <dt>响应字节</dt>
                          <dd>{record.modelTiming.responseBytes.toLocaleString()}</dd>
                          <dt>传输终态</dt>
                          <dd>{record.modelTiming.outcome}</dd>
                        </>
                      )}
                      {record.toolTiming && (
                        <>
                          <dt>工具来源</dt>
                          <dd>{record.toolTiming.source}</dd>
                        </>
                      )}
                    </dl>
                  ),
                },
              ]
            : []),
          {
            key: "identity",
            label: "记录信息",
            children: (
              <>
                <dl className="trace-facts">
                  <dt>记录 ID</dt>
                  <dd>{record.id}</dd>
                  <dt>运行 ID</dt>
                  <dd>{record.runId ?? "未记录"}</dd>
                  <dt>消息 ID</dt>
                  <dd>{record.messageId ?? "未保存或历史未关联"}</dd>
                  {record.toolCallId && (
                    <>
                      <dt>调用 ID</dt>
                      <dd>{record.toolCallId}</dd>
                    </>
                  )}
                  <dt>事件序号</dt>
                  <dd>
                    {record.events.length
                      ? record.events.map((e) => e.seq).join(", ")
                      : "来自已保存的运行或消息"}
                  </dd>
                  {record.usage?.traceId && (
                    <>
                      <dt>Trace ID</dt>
                      <dd>{record.usage.traceId}</dd>
                    </>
                  )}
                </dl>
                <details>
                  <summary>原始协议事件 ({record.events.length})</summary>
                  {plain(record.events)}
                </details>
              </>
            ),
          },
        ]}
      />
    </section>
  );
}
