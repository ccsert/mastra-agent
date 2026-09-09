import type { Run, RunEvent } from "@platform/sdk";

export type TraceRecord = {
  id: string;
  step: number;
  kind: "model" | "tool" | "error";
  title: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  text: string;
  events: RunEvent[];
};
export type TraceStep = { number: number; records: TraceRecord[] };

/** A read-only projection of persisted stream facts. Paging never changes semantic record IDs. */
export function projectTrajectory(
  events: RunEvent[],
  status: Run["status"],
  complete: boolean,
): TraceStep[] {
  const records = new Map<string, TraceRecord>();
  let step = 0;
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    const c = event.chunk,
      type = String(c.type);
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
        : `${kind}:${String(kind === "tool" ? c.toolCallId : c.id)}`;
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
  return [...steps.values()];
}
export function traceDuration(record: TraceRecord) {
  if (!record.finishedAt) return "—";
  const ms = Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt));
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
