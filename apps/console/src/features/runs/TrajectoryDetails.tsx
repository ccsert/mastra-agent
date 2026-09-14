import { useState } from "react";
import { AgentText } from "../../shared/ai/AgentText";
import { ToolResult } from "../../shared/ai/ToolResult";
import { planChanges } from "../../shared/ai/tool-content";
import { AgentPlan } from "../../shared/assistant-ui";
import type { TraceRecord } from "./trajectory";
import { timingSource, traceDuration, traceStates, traceValue } from "./trajectory";
import { asObject, contentTiming, contextChange, duration, tokenCount } from "./trajectory-details";

/** Branches mount on demand, keeping large tool results cheap to inspect. */
export function TraceValue({
  value,
  name = "结果",
  depth = 0,
}: {
  value: unknown;
  name?: string;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [limit, setLimit] = useState(50);
  if (!value || typeof value !== "object")
    return (
      <div className="trace-value-leaf">
        <small>{name}</small>
        <pre>{traceValue(value)}</pre>
      </div>
    );
  const entries = Object.entries(value);
  return (
    <details
      className="trace-value-tree"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <code>{name}</code>
        <span>
          {Array.isArray(value) ? "数组" : "对象"} · {entries.length} 项
        </span>
      </summary>
      {open && (
        <div>
          {entries.slice(0, limit).map(([key, item]) => (
            <TraceValue key={key} name={key} value={item} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <button
              type="button"
              className="trace-inline-action"
              onClick={() => setLimit((n) => n + 50)}
            >
              再显示 50 项（剩余 {entries.length - limit}）
            </button>
          )}
        </div>
      )}
    </details>
  );
}

export function GenerationUsage({ record }: { record: TraceRecord }) {
  const generation = record.generation;
  const usage = generation?.usage;
  const cache =
    usage?.inputTokens && usage.cachedInputTokens != null
      ? (usage.cachedInputTokens / usage.inputTokens) * 100
      : null;
  return (
    <>
      <p className="trace-provenance">
        本次生成由模型供应方报告；失败的网络重试没有独立用量时保留未知。
      </p>
      <dl className="trace-facts">
        <dt>输入 Token</dt>
        <dd>{tokenCount(usage?.inputTokens)}</dd>
        <dt>缓存读取 Token</dt>
        <dd>
          {tokenCount(usage?.cachedInputTokens)}
          {cache !== null ? ` · ${cache.toFixed(1)}%` : ""}
        </dd>
        <dt>输出 Token</dt>
        <dd>{tokenCount(usage?.outputTokens)}</dd>
        <dt>其中推理 Token</dt>
        <dd>{tokenCount(usage?.reasoningTokens)}</dd>
        <dt>总 Token</dt>
        <dd>{tokenCount(usage?.totalTokens)}</dd>
        <dt>结束原因</dt>
        <dd>{generation?.finishReason ?? "未报告"}</dd>
      </dl>
    </>
  );
}

export function RequestOverview({
  record,
  previous,
  details: children,
  onLocate,
}: {
  record: TraceRecord;
  previous?: TraceRecord;
  details: TraceRecord[];
  onLocate?(id: string): void;
}) {
  const request = asObject(record.request),
    change = contextChange(record, previous),
    timing = contentTiming(record, children);
  const tools = children.filter((r) => ["tool", "agent", "plan"].includes(r.kind));
  return (
    <div className="trace-request-overview">
      <div className="trace-metric-grid">
        <div>
          <small>请求耗时</small>
          <strong>{traceDuration(record)}</strong>
        </div>
        <div>
          <small>首内容延迟</small>
          <strong>{duration(timing.wait)}</strong>
        </div>
        <div>
          <small>输入 Token</small>
          <strong>{tokenCount(record.generation?.usage.inputTokens)}</strong>
        </div>
        <div>
          <small>输出 Token</small>
          <strong>{tokenCount(record.generation?.usage.outputTokens)}</strong>
        </div>
      </div>
      <dl className="trace-facts">
        <dt>状态</dt>
        <dd>{traceStates[record.status]}</dd>
        <dt>模型</dt>
        <dd>{String(request.model ?? record.generation?.modelId ?? "未记录")}</dd>
        <dt>生成编号</dt>
        <dd>
          #{record.step} · HTTP 请求 #{record.requestIndex}
        </dd>
        <dt>结束原因</dt>
        <dd>{record.generation?.finishReason ?? "未报告"}</dd>
        <dt>工具调用</dt>
        <dd>
          {tools.length} 次 · {tools.filter((r) => r.status === "failed").length} 次失败
        </dd>
        <dt>输出流跨度</dt>
        <dd>{duration(timing.generating)}</dd>
        <dt>观测输出速率</dt>
        <dd>{timing.rate === null ? "未记录" : `${timing.rate.toFixed(1)} tok/s`}</dd>
      </dl>
      <p className="trace-provenance">
        首内容与输出流跨度来自 Runtime
        收到的非空推理、正文或工具参数事件；不是供应方推理耗时，也不把 HTTP 首字节当作首 Token。
      </p>
      <h4>本次上下文</h4>
      <p>
        {change.total} 条消息 · {record.tools?.length ?? 0} 个可用工具
      </p>
      <p className="trace-provenance">
        {change.comparable
          ? `与上次请求相比：保留前 ${change.shared} 条，${change.removed ? `替换或移除后 ${change.removed} 条，` : ""}新增 ${change.added} 条。${change.definitionsChanged ? "工具定义有变化。" : "工具定义未变化。"}`
          : "当前已加载范围内的首个请求，未与更早请求比较。"}
      </p>
      {previous && (
        <button
          type="button"
          className="trace-inline-action"
          onClick={() => onLocate?.(previous.id)}
        >
          查看上次请求 #{previous.requestIndex}
          {previous.turn !== record.turn ? ` · 第 ${previous.turn} 轮` : ""}
        </button>
      )}
      <h4>执行明细 · {children.length}</h4>
      <div className="trace-child-list">
        {children.map((child) => (
          <button key={child.id} type="button" onClick={() => onLocate?.(child.id)}>
            <span className={`trace-child-dot ${child.segment ?? child.kind}`} />
            <span>
              <strong>{child.title}</strong>
              <small>
                {child.kind === "tool"
                  ? traceValue(child.input).replace(/\s+/g, " ")
                  : child.text.replace(/\s+/g, " ")}
              </small>
            </span>
            <span>
              {traceStates[child.status]}
              <small>{traceDuration(child)}</small>
            </span>
          </button>
        ))}
        {!children.length && <p className="trace-empty">尚无已记录的内容块或工具调用。</p>}
      </div>
    </div>
  );
}

export function ToolOverview({
  record,
  parent,
  onLocate,
}: {
  record: TraceRecord;
  parent?: TraceRecord;
  onLocate?(id: string): void;
}) {
  const firstInput = record.events.find((e) => e.chunk.type === "tool-input-start");
  const available = record.events.find((e) => e.chunk.type === "tool-input-available");
  const start = record.events.find((e) => e.observation?.type === "data-tool-start")?.observation;
  const executionStart =
    record.toolTiming?.startedAt ??
    (start?.type === "data-tool-start" ? start.data.startedAt : undefined);
  const phases = [
    { name: "参数开始生成", at: firstInput?.occurredAt },
    { name: "完整参数事件", at: available?.occurredAt },
    { name: "工具开始执行", at: executionStart },
    {
      name: record.status === "failed" ? "执行失败" : "执行结束",
      at: record.toolTiming?.finishedAt,
    },
  ].sort((a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0));
  return (
    <>
      <dl className="trace-facts">
        <dt>状态</dt>
        <dd>{traceStates[record.status]}</dd>
        <dt>工具来源</dt>
        <dd>
          {record.toolTiming?.source ??
            (start?.type === "data-tool-start" ? start.data.source : "未记录")}
        </dd>
        <dt>{record.toolTiming ? "执行耗时" : "事件跨度"}</dt>
        <dd>{traceDuration(record)}</dd>
        <dt>调用 ID</dt>
        <dd>{record.toolCallId ?? "未记录"}</dd>
        {record.toolTiming?.errorCode && (
          <>
            <dt>错误码</dt>
            <dd>{record.toolTiming.errorCode}</dd>
          </>
        )}
        <dt>计时来源</dt>
        <dd>{timingSource(record)}</dd>
      </dl>
      {parent && (
        <button type="button" className="trace-inline-action" onClick={() => onLocate?.(parent.id)}>
          由 {parent.title} 发起 →
        </button>
      )}
      <h4>调用生命周期</h4>
      <p className="trace-provenance">
        按记录时间排列。参数流与执行钩子独立上报，完整参数事件可能晚于执行开始到达。
      </p>
      <ol className="trace-phase-list">
        {phases.map((phase) => (
          <li key={phase.name} data-recorded={!!phase.at}>
            <span>{phase.name}</span>
            <code>
              {phase.at
                ? new Date(phase.at).toLocaleTimeString("zh-CN", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    fractionalSecondDigits: 3,
                  })
                : "未记录"}
            </code>
          </li>
        ))}
      </ol>
      <h4>{record.status === "failed" ? "失败详情" : "返回结果"}</h4>
      {record.title === "run_skill_script" || Array.isArray(record.output) ? (
        <ToolResult toolName={record.title} result={record.output} />
      ) : (
        <TraceValue value={record.output} />
      )}
    </>
  );
}

export function PlanOverview({
  record,
  records,
  onLocate,
}: {
  record: TraceRecord;
  records: TraceRecord[];
  onLocate?(id: string): void;
}) {
  const plan = record.taskPlan;
  if (!plan) return null;
  const previous = records.findLast(
    (r) =>
      r.runId === record.runId &&
      r.scopeId === record.scopeId &&
      r.taskPlan?.revision === plan.revision - 1,
  );
  const changes = planChanges(plan, previous?.taskPlan);
  return (
    <>
      <AgentPlan title={plan.title} items={plan.items} revision={plan.revision} />
      <h4>本次更新原因</h4>
      <p>{plan.explanation}</p>
      <p className="trace-provenance">
        任务状态由 Agent 更新；完成标记本身不代表工具验证或人工批准。此处保留当时的版本。
      </p>
      <h4>{previous ? `相对 v${previous.taskPlan?.revision} 的变化` : "本版任务"}</h4>
      {!previous && plan.revision > 1 ? (
        <p className="trace-provenance">尚未加载上一版计划，暂不判断任务变更。</p>
      ) : changes.length ? (
        <ul className="trace-plan-changes">
          {changes.map((change) => (
            <li key={change.id}>
              <span>{change.title}</span>
              <small>{change.change}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>任务项未变化；本次更新了计划说明。</p>
      )}
      {previous && (
        <button
          type="button"
          className="trace-inline-action"
          onClick={() => onLocate?.(previous.id)}
        >
          查看上一版计划 v{previous.taskPlan?.revision}
        </button>
      )}
    </>
  );
}

export function SubagentOverview({
  record,
  details,
  onLocate,
}: {
  record: TraceRecord;
  details: TraceRecord[];
  onLocate?(id: string): void;
}) {
  const state = record.subagent;
  if (!state) return null;
  const phases = [
    ["任务入队", state.queuedAt],
    ["开始执行", state.startedAt],
    ["执行结束", state.finishedAt],
  ];
  return (
    <>
      <div className="trace-metric-grid">
        <div>
          <small>子任务状态</small>
          <strong>
            {state.status === "queued"
              ? "排队中"
              : state.status === "rejected"
                ? "已拒绝"
                : traceStates[record.status]}
          </strong>
        </div>
        <div>
          <small>子任务用量</small>
          <strong>{tokenCount(record.usage?.usage.totalTokens)} Token</strong>
        </div>
      </div>
      <h4>分配的任务</h4>
      <p className="trace-task-text">{state.task}</p>
      <dl className="trace-facts">
        <dt>子任务 ID</dt>
        <dd>{state.id}</dd>
        <dt>派发调用 ID</dt>
        <dd>{state.parentToolCallId}</dd>
        <dt>模型</dt>
        <dd>{state.modelId}</dd>
        <dt>步骤上限</dt>
        <dd>{state.maxSteps}</dd>
        <dt>可用工具</dt>
        <dd>{state.allowedTools.join("、") || "未绑定工具"}</dd>
        {state.errorCode && (
          <>
            <dt>错误码</dt>
            <dd>{state.errorCode}</dd>
          </>
        )}
      </dl>
      <p className="trace-provenance">
        使用父任务同一发布版本。子代理只接收分配的任务；其内部请求、推理和工具结果独立记录，用量单独统计。
      </p>
      <ol className="trace-phase-list">
        {phases.map(([name, at]) => (
          <li key={name} data-recorded={!!at}>
            <span>{name}</span>
            <code>
              {at
                ? new Date(at).toLocaleTimeString("zh-CN", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    fractionalSecondDigits: 3,
                  })
                : "未记录"}
            </code>
          </li>
        ))}
      </ol>
      {state.outputText && (
        <>
          <h4>交回主 Agent 的结果</h4>
          <AgentText text={state.outputText} className="trace-markdown" />
        </>
      )}
      <h4>子任务执行明细</h4>
      <div className="trace-child-list">
        {details.map((child) => (
          <button key={child.id} type="button" onClick={() => onLocate?.(child.id)}>
            <span className={`trace-child-dot ${child.kind}`} />
            <span>
              <strong>{child.title}</strong>
              <small>{child.text}</small>
            </span>
            <span>
              {traceStates[child.status]}
              <small>{traceDuration(child)}</small>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
