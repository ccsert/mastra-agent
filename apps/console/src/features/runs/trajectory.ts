import type { ConversationTrace, Run, RunEvent, TraceTurn } from "@platform/sdk";

export type TraceTool = { name: string; description: string; inputSchema?: unknown };

export type TraceRecord = {
  id: string;
  step: number;
  kind: "system" | "user" | "context" | "model" | "tool" | "error";
  title: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  text: string;
  events: RunEvent[];
  source?: string;
  request?: unknown;
  execution?: Pick<Run, "id" | "runtimeId" | "releaseVersion" | "status" | "selectedSkills">;
  tools?: TraceTool[];
  toolsSource?: string;
  turn?: number;
  runId?: string;
};
export type TraceStep = { number: number; records: TraceRecord[] };
export type TraceRun = Pick<Run, "id" | "createdAt" | "inputText" | "agentInstructions"> &
  Partial<Pick<Run, "registeredTools">>;
export const traceStates = {
  running: "进行中",
  succeeded: "完成",
  failed: "失败",
  interrupted: "未完成",
};
export const traceKinds = {
  system: "系统",
  user: "用户",
  context: "上下文",
  model: "助手",
  tool: "工具",
  error: "错误",
};
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
export function tracePreview(record: TraceRecord) {
  if (record.kind === "tool")
    return `${traceValue(record.input ?? (record.text || undefined))} → ${traceValue(record.output)}`
      .replace(/\s+/g, " ")
      .trim();
  return (
    record.text.trim().replace(/\s+/g, " ") ||
    (record.kind === "model" ? "模型未返回正文" : "未记录正文")
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
      tools: requests.length ? requestTools(firstRequest) : (run.registeredTools ?? []),
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
        step: data.requestIndex,
        kind: "context",
        title: `运行上下文 · 请求 #${data.requestIndex}`,
        status: "succeeded",
        startedAt: event.createdAt,
        text: `${String(request.model ?? "模型")} · ${Array.isArray(request.messages) ? request.messages.length : 0} 条消息 · ${Array.isArray(request.tools) ? request.tools.length : 0} 个工具`,
        input: request,
        output: data.preparedAt,
        events: [event],
        source: "Runtime 实际模型请求；包括系统、历史消息及工具 Schema，不含认证请求头",
        tools: requestTools(request),
        toolsSource: "本次实际模型请求中的工具定义",
      });
      continue;
    }
    if (type === "start-step") {
      step++;
      continue;
    }
    if (!type.startsWith("tool-") && !type.startsWith("text-") && type !== "error") continue;
    if (!step) step = 1;
    const kind = type === "error" ? "error" : type.startsWith("tool-") ? "tool" : "model";
    const id =
      kind === "error"
        ? `error:${event.seq}`
        : kind === "tool"
          ? `tool:${String(c.toolCallId)}`
          : `model:${step}:${String(c.id)}`;
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
        startedAt: event.createdAt,
        text: "",
        events: [],
      };
      records.set(id, record);
    }
    record.events.push(event);
    if (typeof c.toolName === "string") record.title = c.toolName;
    if (type === "tool-input-delta") record.text += String(c.inputTextDelta ?? "");
    if (type === "tool-input-available") record.input = c.input;
    if (type === "text-delta") record.text += String(c.delta ?? "");
    if (type === "tool-output-available") record.output = c.output;
    if (["text-end", "tool-output-available"].includes(type)) {
      record.status = "succeeded";
      record.finishedAt = event.createdAt;
    }
    if (["error", "tool-input-error", "tool-output-error", "tool-output-denied"].includes(type)) {
      record.status = "failed";
      record.finishedAt = event.createdAt;
      record.output = c.errorText ?? "调用被拒绝";
      if (c.input !== undefined) record.input = c.input;
    }
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
export function traceDuration(record: TraceRecord) {
  if (!record.finishedAt) return "—";
  const ms = Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt));
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
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
      const context = step.records.find((r) => r.kind === "context");
      const content = step.records.filter((r) => r.kind !== "system" && r.kind !== "context");
      if (!context) return content;
      // A model can return tool calls without a text part. Keep its request inspectable.
      if (!content.some((r) => r.kind === "model")) {
        content.unshift({
          id: context.id,
          step: context.step,
          kind: "model",
          title: "模型请求",
          text: "",
          status: content.some((r) => r.kind === "tool")
            ? "succeeded"
            : ["running", "queued"].includes(turn.run.status) || turn.hasMoreEvents
              ? "running"
              : "interrupted",
          startedAt: context.startedAt,
          events: context.events,
          source: context.source,
        });
      }
      return content.map((r) =>
        r.kind === "model"
          ? {
              ...r,
              request: context.input,
              tools: context.tools,
              toolsSource: context.toolsSource,
            }
          : r,
      );
    });
    if (turn.run.errorCode && !projected.some((r) => r.kind === "error"))
      projected.push({
        id: "run-error",
        step: 0,
        kind: "error",
        title: "运行未完成",
        status: turn.run.status === "cancelled" ? "interrupted" : "failed",
        startedAt: turn.run.createdAt,
        text: turn.run.errorCode,
        output: turn.run.errorCode,
        events: [],
        source: "运行终态",
      });
    records.push(
      ...projected.map((r) => ({
        ...r,
        id: `${turn.run.id}/${r.id}`,
        runId: turn.run.id,
        turn: turn.number,
        ...(r.kind === "user"
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
  return records;
}

export function sessionLog(records: TraceRecord[]) {
  return records.map(
    ({ kind, turn, runId, title, text, input, output, tools, request, execution, source }) => ({
      kind,
      turn,
      runId,
      title,
      text,
      input,
      output,
      tools,
      request,
      execution,
      source,
    }),
  );
}
