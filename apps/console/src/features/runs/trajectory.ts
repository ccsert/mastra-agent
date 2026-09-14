import type {
  ConversationTrace,
  ModelRequestTiming,
  ModelStep,
  Run,
  RunEvent,
  RunUsage,
  SubagentLifecycle,
  TaskPlan,
  ToolExecution,
  TraceTurn,
} from "@platform/sdk";

export type TraceTool = { name: string; description: string; inputSchema?: unknown };

/** A folded display row: never persisted, only produced by `foldTrace`. */
export type TraceSummary = { kind: "turn" | "call"; label: string; turn?: number; call?: string };

export type TraceRecord = {
  id: string;
  step: number;
  kind: "system" | "user" | "context" | "model" | "tool" | "agent" | "plan" | "error" | "run";
  title: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "unloaded";
  startedAt: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  text: string;
  events: RunEvent[];
  source?: string;
  request?: unknown;
  requestIndex?: number;
  parentId?: string;
  toolCallId?: string;
  toolCalls?: string[];
  messageId?: string;
  reasoning?: string;
  timeSource?: "runtime" | "control-plane" | "model-transport" | "tool-execution" | "run";
  modelTiming?: ModelRequestTiming;
  /** Individual model content blocks retain identity and their own event boundaries. */
  segment?: "reasoning" | "text";
  generation?: ModelStep | RunUsage["perStep"][number];
  subagent?: SubagentLifecycle;
  taskPlan?: TaskPlan;
  scopeId?: string;
  scopeName?: string;
  childIds?: string[];
  toolTiming?: ToolExecution;
  usage?: RunUsage;
  coverage?: string[];
  execution?: Pick<Run, "id" | "runtimeId" | "releaseVersion" | "status" | "selectedSkills">;
  tools?: TraceTool[];
  toolsSource?: string;
  turn?: number;
  runId?: string;
  summary?: TraceSummary;
};
export type TraceStep = { number: number; records: TraceRecord[] };
export type TraceRun = Pick<Run, "id" | "createdAt" | "inputText" | "agentInstructions"> &
  Partial<Pick<Run, "registeredTools">>;
export const traceStates = {
  running: "进行中",
  succeeded: "完成",
  failed: "失败",
  interrupted: "未完成",
  unloaded: "待加载",
};
export const traceKinds = {
  system: "系统",
  user: "用户",
  context: "上下文",
  model: "助手",
  tool: "工具",
  agent: "子代理",
  plan: "计划",
  error: "错误",
  run: "运行",
};
export type TraceCategory = "输入" | "模型" | "工具" | "子代理" | "计划" | "错误" | "状态";
export const traceCategories: TraceCategory[] = [
  "输入",
  "模型",
  "工具",
  "子代理",
  "计划",
  "错误",
  "状态",
];
export function traceCategory(record: TraceRecord): TraceCategory {
  if (record.kind === "plan") return "计划";
  if (record.kind === "agent") return "子代理";
  if (["system", "user", "context"].includes(record.kind)) return "输入";
  if (record.kind === "run") return "状态";
  if (record.kind === "tool") return "工具";
  if (record.kind === "model") return "模型";
  return "错误";
}
export type TraceSpan = { record: TraceRecord; left: number; width: number; track: number };
export type TraceTimeline = { lane: TraceCategory; spans: TraceSpan[]; tracks: number }[];
/** Overview lanes share one horizontal time domain. */
export const traceLanes: TraceCategory[] = ["输入", "模型", "工具", "子代理"];
/**
 * Project records onto the overview track. "sequence" gives every record one
 * equal slot; "duration" scales by the control-plane receive span so a slow
 * call reads as wider. Duration is reception time, not model inference time.
 */
export function projectTimeline(
  records: TraceRecord[],
  mode: "sequence" | "duration",
): TraceTimeline {
  records = records.filter((r) => !r.segment);
  const lanes = records.some((r) => r.kind === "plan")
    ? [...traceLanes, "计划" as const]
    : traceLanes;
  if (mode === "sequence") {
    const total = Math.max(1, records.length);
    return lanes.map((lane) => ({
      lane,
      tracks: 1,
      spans: records
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => traceCategory(record) === lane)
        .map(({ record, index }) => ({
          record,
          track: 0,
          left: (index / total) * 100,
          width: (1 / total) * 100,
        })),
    }));
  }
  const values = records
    .map((record) => {
      const start = Date.parse(record.startedAt);
      const finished = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
      return {
        record,
        start,
        end: Number.isFinite(finished) && finished >= start ? finished : start,
      };
    })
    .filter((value) => Number.isFinite(value.start));
  if (!values.length) return lanes.map((lane) => ({ lane, spans: [], tracks: 1 }));
  const start = values.reduce((min, v) => Math.min(min, v.start), Infinity);
  const end = values.reduce((max, v) => Math.max(max, v.end), -Infinity);
  const span = end - start || 1;
  return lanes.map((lane) => {
    const trackEnds: number[] = [];
    const spans = values
      .filter((value) => traceCategory(value.record) === lane)
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .map((value) => {
        let track = trackEnds.findIndex((end) => end <= value.start);
        if (track === -1) track = Math.min(trackEnds.length, 2);
        // Point observations occupy a tiny visual slot without inventing a duration.
        trackEnds[track] = Math.max(value.end, value.start + span / 500);
        return {
          record: value.record,
          track,
          left: ((value.start - start) / span) * 100,
          width: ((value.end - value.start) / span) * 100,
        };
      });
    return { lane, spans, tracks: Math.max(1, trackEnds.length) };
  });
}
export function traceValue(value: unknown): string {
  return value === undefined
    ? "尚未收到"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function requestTools(request: Record<string, unknown>): TraceTool[] {
  return Array.isArray(request.tools)
    ? request.tools
        .map(object)
        .map((t) => object(t.function))
        .filter((t) => typeof t.name === "string")
        .map((t) => ({
          name: String(t.name),
          description: String(t.description ?? ""),
          inputSchema: t.parameters,
        }))
    : [];
}
function previewValue(value: unknown, depth = 0): string {
  if (value === undefined) return "尚未收到";
  if (typeof value === "string") return value.slice(0, 180);
  if (value === null || typeof value !== "object") return String(value);
  if (depth >= 2) return Array.isArray(value) ? `[${value.length} 项]` : "{…}";
  return Object.entries(value)
    .slice(0, 4)
    .map(([key, item]) => `${key}: ${previewValue(item, depth + 1)}`)
    .join(", ")
    .slice(0, 180);
}
export function tracePreview(record: TraceRecord) {
  if (record.taskPlan)
    return `${record.taskPlan.items.filter((item) => item.status === "completed").length} / ${record.taskPlan.items.length} 项完成 · ${record.taskPlan.explanation}`;
  if (record.kind === "tool")
    return `${previewValue(record.input ?? (record.text || undefined))} → ${previewValue(record.output)}`
      .replace(/\s+/g, " ")
      .trim();
  return (
    (record.text || record.reasoning || "").slice(0, 360).trim().replace(/\s+/g, " ") ||
    (record.kind === "model"
      ? record.toolCalls?.length
        ? `发起 ${record.toolCalls.length} 次工具调用`
        : record.status === "failed"
          ? "请求失败，未收到正文"
          : record.status === "running"
            ? "等待模型响应…"
            : "模型未返回正文"
      : "未记录正文")
  );
}

/** A read-only projection of persisted stream facts. Paging never changes semantic record IDs. */
export function projectTrajectory(
  events: RunEvent[],
  status: Run["status"],
  complete: boolean,
  run?: TraceRun,
): TraceStep[] {
  const records = new Map<string, TraceRecord>();
  events = [...new Map(events.map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
  const requests = events.filter((e) => e.chunk.type === "data-model-request");
  const firstRequest = object(object(requests[0]?.chunk.data).request);
  const systems = Array.isArray(firstRequest.messages)
    ? firstRequest.messages.map(object).filter((m) => m.role === "system" || m.role === "developer")
    : [];
  const instructions = systems
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
  if (run) {
    records.set("system", {
      id: "system",
      step: 0,
      kind: "system",
      title: "初始系统提示词",
      status: "succeeded",
      startedAt: run.createdAt,
      text: instructions || run.agentInstructions || "",
      events: requests.slice(0, 1),
      source: instructions ? "Runtime 实际模型请求" : "发布版本快照；此历史运行未记录完整模型请求",
      tools: requests.length ? requestTools(firstRequest) : [...(run.registeredTools ?? [])],
      toolsSource: requests.length
        ? "首次实际模型请求中的工具定义"
        : "发布版本工具绑定；历史 Runtime 动态工具定义未记录",
    });
    records.set("user", {
      id: "user",
      step: 0,
      kind: "user",
      title: "用户输入",
      status: "succeeded",
      startedAt: run.createdAt,
      text: run.inputText ?? "",
      events: [],
      source: "运行绑定的用户消息",
    });
  }
  let step = 0;
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    const c = event.chunk,
      type = String(c.type);
    if (type === "data-model-request") {
      const data = object(c.data),
        request = object(data.request);
      if (typeof data.requestIndex !== "number") continue;
      const id = `request:${event.seq}`;
      records.set(id, {
        id,
        step: typeof data.stepIndex === "number" ? data.stepIndex + 1 : data.requestIndex,
        requestIndex: data.requestIndex,
        kind: "context",
        title: `运行上下文 · 请求 #${data.requestIndex}`,
        status: "succeeded",
        startedAt: event.occurredAt ?? event.createdAt,
        timeSource: event.timeSource ?? "control-plane",
        text: `${String(request.model ?? "模型")} · ${Array.isArray(request.messages) ? request.messages.length : 0} 条消息 · ${Array.isArray(request.tools) ? request.tools.length : 0} 个工具`,
        input: request,
        output: data.preparedAt,
        events: [event],
        source:
          typeof data.stepIndex === "number"
            ? "Runtime 实际模型请求；按生成编号关联，不含认证请求头"
            : "Runtime 实际模型请求；旧记录未保存生成编号，输出关联按顺序推断，不含认证请求头",
        tools: requestTools(request),
        toolsSource: "本次实际模型请求中的工具定义",
      });
      continue;
    }
    if (
      type === "source-url" ||
      type === "source-document" ||
      type === "file" ||
      (type.startsWith("data-") &&
        ![
          "data-model-response",
          "data-tool-execution",
          "data-run-usage",
          "data-run-capabilities",
          "data-model-step",
          "data-tool-start",
          "data-subagent",
          "data-subagent-event",
          "data-task-plan",
        ].includes(type))
    ) {
      const id = `extension:${event.seq}`;
      records.set(id, {
        id,
        step,
        kind: "context",
        title: type.startsWith("source-") ? "引用来源" : type === "file" ? "生成文件" : "扩展记录",
        status: "succeeded",
        startedAt: event.occurredAt ?? event.createdAt,
        timeSource: event.timeSource,
        text: String(c.title ?? c.url ?? c.filename ?? type),
        input: c,
        events: [event],
        source: "已保存的扩展协议内容",
      });
      continue;
    }
    if (type === "start-step") {
      step++;
      continue;
    }
    if (
      !type.startsWith("tool-") &&
      !type.startsWith("text-") &&
      !type.startsWith("reasoning-") &&
      type !== "error"
    )
      continue;
    if (!step) step = 1;
    const kind = type === "error" ? "error" : type.startsWith("tool-") ? "tool" : "model";
    const id =
      kind === "error"
        ? `error:${event.seq}`
        : kind === "tool"
          ? `tool:${String(c.toolCallId)}`
          : `${type.startsWith("reasoning-") ? "reasoning" : "model"}:${step}:${String(c.id)}`;
    let record = records.get(id);
    if (!record) {
      record = {
        id,
        step,
        kind,
        title:
          kind === "tool"
            ? String(c.toolName ?? "工具调用")
            : kind === "error"
              ? "执行错误"
              : "模型输出",
        status: "running",
        startedAt: event.occurredAt ?? event.createdAt,
        timeSource: event.timeSource ?? "control-plane",
        text: "",
        ...(kind === "tool" ? { toolCallId: String(c.toolCallId) } : {}),
        events: [],
      };
      records.set(id, record);
    }
    record.events.push(event);
    if (typeof c.toolName === "string") record.title = c.toolName;
    if (type === "tool-input-delta") record.text += String(c.inputTextDelta ?? "");
    if (type === "tool-input-available") record.input = c.input;
    if (type === "text-delta") record.text += String(c.delta ?? "");
    if (type === "reasoning-delta")
      record.reasoning = (record.reasoning ?? "") + String(c.delta ?? "");
    if (type === "tool-output-available") record.output = c.output;
    if (["text-end", "reasoning-end", "tool-output-available"].includes(type)) {
      record.status = "succeeded";
      record.finishedAt = event.occurredAt ?? event.createdAt;
    }
    if (["error", "tool-input-error", "tool-output-error", "tool-output-denied"].includes(type)) {
      record.status = "failed";
      record.finishedAt = event.occurredAt ?? event.createdAt;
      record.output = c.errorText ?? "调用被拒绝";
      if (c.input !== undefined) record.input = c.input;
    }
  }
  for (const event of events) {
    const observation = event.observation;
    if (observation?.type === "data-model-response") {
      const timing = observation.data;
      let record = [...records.values()].find((r) => r.requestIndex === timing.requestIndex);
      if (!record) {
        record = {
          id: `response:${event.seq}`,
          step: timing.requestIndex,
          requestIndex: timing.requestIndex,
          kind: "context",
          title: `模型请求 #${timing.requestIndex}`,
          status: "running",
          text: "请求正文未采集",
          events: [],
          startedAt: timing.startedAt,
        };
        records.set(record.id, record);
      }
      record.modelTiming = timing;
      record.startedAt = timing.startedAt;
      record.finishedAt = timing.completedAt;
      record.timeSource = "model-transport";
      record.events.push(event);
      record.status =
        timing.outcome === "failed" || (timing.httpStatus ?? 0) >= 400
          ? "failed"
          : timing.outcome === "incomplete"
            ? "interrupted"
            : "succeeded";
    }
    if (observation?.type === "data-tool-start" || observation?.type === "data-tool-execution") {
      const timing = observation.data;
      let record = records.get(`tool:${timing.toolCallId}`);
      if (!record) {
        record = {
          id: `tool:${timing.toolCallId}`,
          step: 1,
          kind: "tool",
          title: timing.toolName,
          toolCallId: timing.toolCallId,
          status: "running",
          text: "",
          events: [],
          startedAt: timing.startedAt,
        };
        records.set(record.id, record);
      }
      if (record) {
        record.startedAt = timing.startedAt;
        record.timeSource = "tool-execution";
        record.events.push(event);
        if (observation.type === "data-tool-execution") {
          record.toolTiming = observation.data;
          record.finishedAt = observation.data.finishedAt;
          record.status = observation.data.outcome === "failed" ? "failed" : "succeeded";
        }
      }
    }
  }
  for (const event of events) {
    if (event.observation?.type !== "data-task-plan") continue;
    const plan = event.observation.data;
    const id = `tool:${plan.toolCallId}`;
    let record = records.get(id);
    if (!record) {
      const parent = [...records.values()].findLast(
        (r) => r.requestIndex !== undefined && r.events.some((e) => e.seq < event.seq),
      );
      record = {
        id,
        step: parent?.step ?? 1,
        kind: "plan",
        title: "任务计划",
        status: "succeeded",
        startedAt: plan.updatedAt,
        text: "",
        events: [],
        toolCallId: plan.toolCallId,
        parentId: parent?.id,
      };
      records.set(id, record);
    }
    record.kind = "plan";
    record.title = `计划 · ${plan.title} · v${plan.revision}`;
    record.taskPlan = plan;
    record.text = `${plan.explanation}\n${plan.items.map((item) => `${item.title} ${item.status} ${item.detail ?? ""}`).join("\n")}`;
    record.output = plan;
    record.source = "Runtime 已保存的计划版本；事项状态由 Agent 报告，不等于独立验收或用户批准";
    record.events.push(event);
  }
  if (complete && !["running", "queued"].includes(status)) {
    for (const record of records.values())
      if (record.status === "running") record.status = "interrupted";
  }
  const steps = new Map<number, TraceStep>();
  for (const record of records.values()) {
    if (!steps.has(record.step)) steps.set(record.step, { number: record.step, records: [] });
    steps.get(record.step)?.records.push(record);
  }
  return [...steps.values()].sort((a, b) => a.number - b.number);
}
export function traceDuration(record: TraceRecord, now?: number) {
  const end = record.finishedAt
    ? Date.parse(record.finishedAt)
    : record.status === "running"
      ? now
      : undefined;
  if (end === undefined) return "—";
  const ms = Math.max(0, end - Date.parse(record.startedAt));
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Cache at turn boundaries so loading one tail never reprojects older turns. */
export function createConversationProjector() {
  const cache = new WeakMap<TraceTurn, TraceRecord[]>();
  return (initial: ConversationTrace["initial"], turns: TraceTurn[]) => {
    const records = [...turns]
      .sort((a, b) => a.number - b.number)
      .flatMap((turn) => {
        let projected = cache.get(turn);
        if (!projected) {
          projected = projectConversation(null, [turn]);
          cache.set(turn, projected);
        }
        return projected;
      });
    const system = projectConversation(initial, []);
    if (initial && !initial.request && system[0]) {
      const known = new Set(system[0].tools?.map((tool) => tool.name));
      for (const record of records) {
        if (record.kind !== "tool" || known.has(record.title)) continue;
        system[0].tools?.push({
          name: record.title,
          description: "已出现在调用记录中；历史注册定义未保存",
        });
        known.add(record.title);
      }
    }
    return [...system, ...records];
  };
}

/** Conversation turns are user submissions, never individual model/tool steps. */
export function projectConversation(
  initial: ConversationTrace["initial"],
  turns: TraceTurn[],
): TraceRecord[] {
  const records: TraceRecord[] = [];
  if (initial) {
    const system = projectTrajectory(
      initial.request ? [initial.request] : [],
      initial.run.status,
      true,
      initial.run,
    )[0].records[0];
    if (!initial.request) {
      const known = new Set(system.tools?.map((t) => t.name));
      for (const turn of turns)
        for (const step of projectTrajectory(turn.events, turn.run.status, !turn.hasMoreEvents))
          for (const r of step.records) {
            if (r.kind === "tool" && !known.has(r.title)) {
              system.tools?.push({
                name: r.title,
                description: "已出现在调用记录中；历史注册定义未保存",
              });
              known.add(r.title);
            }
          }
    }
    records.push({ ...system, id: `${initial.run.id}/system`, runId: initial.run.id });
  }
  for (const turn of [...turns].sort((a, b) => a.number - b.number)) {
    const projected = projectTrajectory(
      turn.events,
      turn.run.status,
      !turn.hasMoreEvents,
      turn.run,
    ).flatMap((step) => {
      const contexts = step.records.filter((r) => r.requestIndex !== undefined);
      const content = step.records.filter(
        (r) => r.kind !== "system" && r.requestIndex === undefined,
      );
      if (!contexts.length) return content;
      // A retry is a distinct request. Only the final non-failed attempt can own
      // this semantic step's output; transport index is not a model step index.
      const owner = [...contexts]
        .reverse()
        .find((r) => r.status !== "failed" && r.status !== "interrupted");
      const models = content.filter((r) => r.kind === "model");
      const stepEvent = turn.events.findLast(
        (e) =>
          e.observation?.type === "data-model-step" &&
          e.observation.data.stepIndex === step.number - 1,
      );
      const stepObservation = stepEvent?.observation;
      const finalUsageEvent = turn.events.findLast((e) => e.observation?.type === "data-run-usage");
      const finalUsage = finalUsageEvent?.observation;
      const metricsEvent = stepEvent ?? finalUsageEvent;
      const generation =
        stepObservation?.type === "data-model-step"
          ? stepObservation.data
          : finalUsage?.type === "data-run-usage"
            ? finalUsage.data.perStep.find((s) => s.stepIndex === step.number - 1)
            : undefined;
      const requests: TraceRecord[] = contexts.map((r) => ({
        ...r,
        kind: "model",
        title: `模型请求 #${r.requestIndex}`,
        text: r === owner ? models.map((m) => m.text).join("") : "",
        reasoning: r === owner ? models.map((m) => m.reasoning ?? "").join("") : undefined,
        request: r.input,
        // Only a captured semantic index supports attaching per-step usage to a request.
        generation:
          r === owner && r.events.some((e) => typeof object(e.chunk.data).stepIndex === "number")
            ? generation
            : undefined,
        ...(!r.modelTiming && r === owner && models.length
          ? {
              finishedAt: models.at(-1)?.finishedAt,
            }
          : {}),
        events: [
          ...r.events,
          ...(r === owner ? models.flatMap((m) => m.events) : []),
          ...(r === owner && generation && metricsEvent ? [metricsEvent] : []),
        ].sort((a, b) => a.seq - b.seq),
        status:
          r === owner && content.some((m) => m.kind === "error" && m.status === "failed")
            ? "failed"
            : r.modelTiming
              ? r.status
              : ["running", "queued"].includes(turn.run.status) || turn.hasMoreEvents
                ? "running"
                : r === owner && content.some((m) => m.status === "succeeded")
                  ? "succeeded"
                  : "interrupted",
      }));
      return [
        ...requests,
        ...content
          .filter(
            (r) =>
              !owner ||
              r.kind !== "model" ||
              r.status === "running" ||
              (r.reasoning ?? r.text).trim(),
          )
          .map((r) => ({
            ...r,
            ...(r.kind === "model" && owner
              ? {
                  parentId: owner.id,
                  segment: r.reasoning !== undefined ? ("reasoning" as const) : ("text" as const),
                  title: r.reasoning !== undefined ? "推理过程" : "正文输出",
                  text: r.reasoning ?? r.text,
                  source: "Runtime 流式内容块；保留独立内容、顺序与事件时间",
                }
              : {}),
            ...(["tool", "plan"].includes(r.kind) && owner
              ? {
                  parentId: owner.id,
                  tools: owner.tools?.filter(
                    (t) => t.name === (r.kind === "plan" ? "update_plan" : r.title),
                  ),
                  toolsSource: owner.toolsSource,
                }
              : {}),
          })),
      ];
    });
    const usage = turn.events
      .map((e) => e.observation)
      .findLast((o) => o?.type === "data-run-usage");
    const missing: string[] = [];
    if (!turn.events.some((e) => e.chunk.type === "data-model-request"))
      missing.push("实际模型请求未采集");
    if (!turn.events.some((e) => e.observation?.type === "data-model-response"))
      missing.push("模型请求计时未采集");
    if (!usage) missing.push("模型用量未采集");
    else if (
      usage.type === "data-run-usage" &&
      Object.values(usage.data.usage).every((n) => n === null)
    )
      missing.push("供应方未报告 Token 用量");
    if (
      !turn.events.some((e) => e.chunk.type === "reasoning-delta") &&
      !turn.events.some(
        (e) => e.chunk.type === "data-run-capabilities" && object(e.chunk.data).reasoning === true,
      )
    )
      missing.push("历史推理未记录，无法判断当时是否产生");
    if (turn.hasMoreEvents) {
      missing.length = 0;
      missing.push("后续事件尚未加载，采集完整性待确认");
    }
    // The stored assistant message is an independent source of truth. Offer it
    // on the run record even if streaming events are incomplete; never invent deltas.
    const assistant = turn.messages?.find((m) => m.role === "assistant");
    if (
      !turn.hasMoreEvents &&
      !projected.some((r) => r.kind === "model" && r.text.trim()) &&
      turn.run.outputText
    ) {
      projected.push({
        id: "stored-output",
        step: 0,
        kind: "model",
        title: "已保存的回复",
        text: turn.run.outputText,
        status: "succeeded",
        startedAt: turn.run.finishedAt ?? turn.run.createdAt,
        events: [],
        messageId: assistant?.id,
        source: "运行保存的最终回复；流式正文未记录，无法还原中间过程",
      });
    }
    projected.push({
      id: "run-status",
      step: 0,
      kind: "run",
      title: "本轮运行",
      text: `${turn.run.status === "succeeded" ? "运行完成" : turn.run.status === "cancelled" ? "运行已取消" : turn.run.status === "failed" ? "运行失败" : "运行中"}${turn.run.errorCode ? ` · ${turn.run.errorCode}` : ""}`,
      status:
        turn.run.status === "succeeded"
          ? "succeeded"
          : turn.run.status === "failed"
            ? "failed"
            : turn.run.status === "cancelled"
              ? "interrupted"
              : "running",
      startedAt: turn.run.createdAt,
      finishedAt: turn.run.finishedAt ?? undefined,
      timeSource: "run",
      events: [],
      output: assistant ?? turn.run.outputText ?? undefined,
      messageId: assistant?.id,
      usage: usage?.type === "data-run-usage" ? usage.data : undefined,
      coverage: missing,
      source: "控制面运行状态与已保存消息；采集缺口不代表模型没有产生相应内容",
    });
    const withChildren = attachSubagents(projected, turn);
    records.push(
      ...withChildren.map((r) => ({
        ...r,
        id: `${turn.run.id}/${r.id}`,
        status:
          turn.hasMoreEvents &&
          !["running", "queued"].includes(turn.run.status) &&
          r.status === "running"
            ? "unloaded"
            : r.status,
        runId: turn.run.id,
        parentId: r.parentId ? `${turn.run.id}/${r.parentId}` : undefined,
        messageId: r.scopeId
          ? undefined
          : (r.messageId ??
            turn.messages?.find((m) => m.role === (r.kind === "user" ? "user" : "assistant"))?.id),
        turn: turn.number,
        ...(!r.scopeId && ["user", "run"].includes(r.kind)
          ? {
              execution: {
                id: turn.run.id,
                runtimeId: turn.run.runtimeId,
                releaseVersion: turn.run.releaseVersion,
                status: turn.run.status,
                selectedSkills: turn.run.selectedSkills,
              },
            }
          : {}),
      })),
    );
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const [toolId, ownerId] of toolOwners(records)) {
    const owner = byId.get(ownerId);
    if (owner) {
      owner.toolCalls ??= [];
      owner.toolCalls.push(toolId);
    }
  }
  for (const r of records) {
    if (!r.parentId) continue;
    const owner = byId.get(r.parentId);
    if (owner) {
      owner.childIds ??= [];
      owner.childIds.push(r.id);
    }
  }
  return records;
}

/** Unwrap a child's scoped log before projection, then namespace every local id.
 * Neither a reused provider id nor parallel arrival order can cross child boundaries. */
function attachSubagents(projected: TraceRecord[], turn: TraceTurn): TraceRecord[] {
  const states = new Map<string, { state: SubagentLifecycle; events: RunEvent[] }>();
  for (const event of turn.events) {
    if (event.observation?.type !== "data-subagent") continue;
    const state = event.observation.data;
    const previous = states.get(state.id);
    states.set(state.id, { state, events: [...(previous?.events ?? []), event] });
  }
  if (!states.size) return projected;
  const children = new Map<string, TraceRecord[]>();
  for (const { state, events } of states.values()) {
    const childEvents = turn.events.flatMap((event): RunEvent[] => {
      const observation = event.observation;
      if (
        observation?.type !== "data-subagent-event" ||
        observation.data.id !== state.id ||
        observation.data.parentToolCallId !== state.parentToolCallId
      )
        return [];
      const data = observation.data;
      // Delegation is one level deep. Unknown nested wrappers remain in the raw export.
      if (["data-subagent", "data-subagent-event"].includes(String(data.chunk.type))) return [];
      return [
        {
          ...event,
          chunk: data.chunk,
          occurredAt: data.occurredAt,
          timeSource: "runtime",
          observation: data.observation,
        },
      ];
    });
    const terminal = !["queued", "running"].includes(state.status);
    const interrupted =
      !terminal && !turn.hasMoreEvents && !["queued", "running"].includes(turn.run.status);
    const status: Run["status"] =
      interrupted || state.status === "cancelled"
        ? "cancelled"
        : state.status === "rejected"
          ? "failed"
          : state.status;
    const childRun: Run = {
      ...turn.run,
      id: state.id,
      status,
      inputText: state.task,
      outputText: state.outputText ?? null,
      createdAt: state.startedAt ?? state.queuedAt,
      finishedAt: state.finishedAt,
      errorCode: state.errorCode ?? null,
    };
    const childRecords = projectConversation(null, [
      {
        number: turn.number,
        run: childRun,
        events: childEvents,
        hasMoreEvents: turn.hasMoreEvents,
      },
    ]);
    let owner = projected.find((r) => r.toolCallId === state.parentToolCallId);
    if (!owner) {
      const parent = projected.findLast(
        (r) => r.requestIndex !== undefined && r.events.some((e) => e.seq < events[0].seq),
      );
      owner = {
        id: `tool:${state.parentToolCallId}`,
        step: parent?.step ?? 1,
        kind: "agent",
        title: state.name,
        status: "running",
        text: state.task,
        startedAt: state.queuedAt,
        events: [],
        toolCallId: state.parentToolCallId,
        parentId: parent?.id,
        input: { name: state.name, task: state.task },
      };
      const parentIndex = parent ? projected.indexOf(parent) : -1;
      projected.splice(parentIndex < 0 ? projected.length - 1 : parentIndex + 1, 0, owner);
    }
    Object.assign(owner, {
      kind: "agent",
      title: `子代理 · ${state.name}`,
      subagent: state,
      text: state.task,
      startedAt: state.startedAt ?? state.queuedAt,
      finishedAt: state.finishedAt ?? undefined,
      status:
        interrupted || state.status === "cancelled"
          ? "interrupted"
          : state.status === "rejected" || state.status === "failed"
            ? "failed"
            : state.status === "succeeded"
              ? "succeeded"
              : "running",
      source: interrupted
        ? "父运行已结束，子任务终态未记录"
        : "独立子代理执行；沿用父任务发布版本和授权范围",
      usage: childRecords.find((r) => r.kind === "run")?.usage,
      events: [...new Map([...owner.events, ...events].map((e) => [e.seq, e])).values()].sort(
        (a, b) => a.seq - b.seq,
      ),
    });
    children.set(
      owner.id,
      childRecords.map((record) => ({
        ...record,
        id: `child/${record.id}`,
        parentId: record.parentId ? `child/${record.parentId}` : owner.id,
        scopeId: state.id,
        scopeName: state.name,
        toolCalls: undefined,
        childIds: undefined,
        // Parent conversation message ids do not identify the child's isolated messages.
        messageId: undefined,
        execution: undefined,
        ...(record.kind === "user"
          ? { title: "子任务输入" }
          : record.kind === "run"
            ? { title: "子任务终态" }
            : {}),
      })),
    );
  }
  return projected.flatMap((record) => [record, ...(children.get(record.id) ?? [])]);
}

export type TraceFoldState = { turns: ReadonlySet<number>; calls: ReadonlySet<string> };

/**
 * Map each tool record to the model record it follows in the same turn. Only
 * tools directly after a model (other tools ignored) belong to a call group.
 */
export function toolOwners(records: TraceRecord[]): Map<string, string> {
  const owners = new Map<string, string>();
  let last: TraceRecord | undefined;
  for (const record of records) {
    if (record.segment) continue;
    if (record.kind === "tool" || record.kind === "agent" || record.kind === "plan") {
      if (record.parentId) {
        owners.set(record.id, record.parentId);
        continue;
      }
      if (last?.kind === "model" && last.turn === record.turn && last.scopeId === record.scopeId)
        owners.set(record.id, last.id);
      continue;
    }
    last = record;
  }
  return owners;
}
/** Model records that own at least one tool call, in display order. */
export function callGroups(records: TraceRecord[]): { id: string; tools: TraceRecord[] }[] {
  const owners = toolOwners(records);
  const groups = new Map<string, TraceRecord[]>();
  for (const record of records) {
    const owner = record.parentId ?? owners.get(record.id);
    if (!owner) continue;
    groups.set(owner, [...(groups.get(owner) ?? []), record]);
  }
  return records
    .filter(
      (record) =>
        ["model", "agent"].includes(record.kind) && !record.segment && groups.has(record.id),
    )
    .map((record) => ({ id: record.id, tools: groups.get(record.id) ?? [] }));
}
/** Turns in display order with their record and tool counts. */
export function turnGroups(records: TraceRecord[]) {
  const groups = new Map<
    number,
    { turn: number; count: number; tools: number; anchorId: string }
  >();
  for (const record of records) {
    if (record.turn === undefined) continue;
    const group = groups.get(record.turn);
    if (group) {
      group.count++;
      if (record.kind === "tool") group.tools++;
    } else
      groups.set(record.turn, {
        turn: record.turn,
        count: 1,
        tools: record.kind === "tool" ? 1 : 0,
        anchorId: record.id,
      });
  }
  return [...groups.values()];
}
function summaryRow(anchor: TraceRecord, summary: TraceSummary): TraceRecord {
  return {
    id: summary.kind === "turn" ? `turn-summary:${summary.turn}` : `call-summary:${summary.call}`,
    step: anchor.step,
    kind: "context",
    title: summary.kind === "turn" ? `第 ${summary.turn} 轮` : "工具调用",
    status: anchor.status,
    startedAt: anchor.startedAt,
    finishedAt: anchor.finishedAt,
    text: "",
    events: [],
    turn: anchor.turn,
    runId: anchor.runId,
    summary,
  };
}
/** Replace folded turns and tool-call groups with one summary row each. */
export function foldTrace(records: TraceRecord[], folded: TraceFoldState): TraceRecord[] {
  const owners = toolOwners(records);
  const byId = new Map(records.map((r) => [r.id, r]));
  const turns = new Map(turnGroups(records).map((group) => [group.turn, group]));
  const groups = new Map(callGroups(records).map((group) => [group.id, group.tools]));
  const out: TraceRecord[] = [];
  for (const record of records) {
    if (record.turn !== undefined && folded.turns.has(record.turn)) {
      const group = turns.get(record.turn);
      if (group?.anchorId === record.id) {
        out.push(record);
        out.push(
          summaryRow(
            { ...record, status: aggregateStatus(records.filter((r) => r.turn === record.turn)) },
            {
              kind: "turn",
              turn: record.turn,
              label: `${group.count - 1} 条记录 · ${group.tools} 次调用`,
            },
          ),
        );
      }
      continue;
    }
    let ancestor = record.parentId ?? owners.get(record.id);
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor) && !folded.calls.has(ancestor)) {
      visited.add(ancestor);
      ancestor = byId.get(ancestor)?.parentId ?? owners.get(ancestor);
    }
    if (ancestor && folded.calls.has(ancestor)) continue;
    if (["model", "agent"].includes(record.kind) && folded.calls.has(record.id)) {
      out.push(record);
      const tools = groups.get(record.id);
      if (tools?.length)
        out.push(
          summaryRow(
            { ...record, status: aggregateStatus(tools) },
            {
              kind: "call",
              call: record.id,
              label:
                record.kind === "agent"
                  ? `${tools.length} 条子任务明细`
                  : tools.some((r) => r.segment)
                    ? `${tools.length} 条明细 · ${tools.filter((r) => ["tool", "plan", "agent"].includes(r.kind)).length} 次工具调用`
                    : `${tools.length} 次工具调用`,
            },
          ),
        );
      continue;
    }
    if (["tool", "plan", "agent"].includes(record.kind) || record.segment) {
      const owner = record.parentId ?? owners.get(record.id);
      if (owner && folded.calls.has(owner)) continue;
    }
    out.push(record);
  }
  return out;
}
/** Fold keys that must open for a record to become visible again. */
export function unfoldTarget(records: TraceRecord[], id: string) {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) return {};
  const call =
    record.parentId ??
    (["tool", "plan", "agent"].includes(record.kind)
      ? toolOwners(records).get(record.id)
      : undefined);
  const calls: string[] = [];
  let ancestor = call;
  while (ancestor && !calls.includes(ancestor)) {
    calls.push(ancestor);
    ancestor = records.find((r) => r.id === ancestor)?.parentId;
  }
  return {
    ...(record.turn === undefined ? {} : { turn: record.turn }),
    ...(call === undefined ? {} : { call }),
    ...(calls.length > 1 ? { calls } : {}),
  };
}

export function sessionLog(records: TraceRecord[]) {
  return records.map(({ events, ...record }) => ({
    ...record,
    eventSequences: events.map((e) => e.seq),
  }));
}

export function timingSource(record: TraceRecord) {
  return {
    "model-transport": "Runtime 模型 HTTP 请求（首字节不等于首 Token）",
    "tool-execution": "Runtime 工具执行钩子",
    runtime: "Runtime 事件产生时间",
    "control-plane": "控制面接收事件的时间戳（历史回退）",
    run: "控制面运行生命周期（含排队）",
  }[record.timeSource ?? "control-plane"];
}

export function aggregateStatus(records: TraceRecord[]): TraceRecord["status"] {
  for (const status of ["failed", "running", "interrupted", "unloaded"] as const)
    if (records.some((r) => r.status === status)) return status;
  return "succeeded";
}
