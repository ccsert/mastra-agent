import type { TraceRecord } from "./trajectory";

export const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function requestMessages(record?: TraceRecord) {
  const messages = asObject(record?.request).messages;
  return Array.isArray(messages) ? messages.map(asObject) : [];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
/** Compare the actual payloads, never the current agent configuration. */
export function contextChange(record: TraceRecord, previous?: TraceRecord) {
  const messages = requestMessages(record),
    before = requestMessages(previous);
  let shared = 0;
  if (previous)
    while (
      shared < Math.min(messages.length, before.length) &&
      canonical(messages[shared]) === canonical(before[shared])
    )
      shared++;
  const names = new Set(record.tools?.map((t) => t.name));
  const oldNames = new Set(previous?.tools?.map((t) => t.name));
  return {
    total: messages.length,
    shared,
    added: messages.length - shared,
    removed: previous ? before.length - shared : 0,
    comparable: !!previous,
    toolsAdded: [...names].filter((n) => !oldNames.has(n)),
    toolsRemoved: [...oldNames].filter((n) => !names.has(n)),
    definitionsChanged: !!previous && canonical(record.tools) !== canonical(previous.tools),
  };
}
export function duration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "未记录";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
export const tokenCount = (value: number | null | undefined) =>
  value == null ? "未报告" : value.toLocaleString();

/** Times refer to observed Runtime content events, not provider inference or wire TTFT. */
export function contentTiming(record: TraceRecord, children: TraceRecord[]) {
  const events = [
    ...new Map([record, ...children].flatMap((r) => r.events).map((e) => [e.seq, e])).values(),
  ]
    .filter(
      (e) =>
        e.timeSource === "runtime" &&
        ((["text-delta", "reasoning-delta"].includes(String(e.chunk.type)) &&
          typeof e.chunk.delta === "string" &&
          e.chunk.delta.length > 0) ||
          (e.chunk.type === "tool-input-delta" &&
            typeof e.chunk.inputTextDelta === "string" &&
            e.chunk.inputTextDelta.length > 0)),
    )
    .sort((a, b) => a.seq - b.seq);
  const first = events[0]?.occurredAt,
    last = events.at(-1)?.occurredAt;
  const start = record.modelTiming?.startedAt;
  const wait = first && start ? Date.parse(first) - Date.parse(start) : null;
  const generating = first && last ? Date.parse(last) - Date.parse(first) : null;
  const output = record.generation?.usage.outputTokens;
  return {
    first,
    last,
    count: events.length,
    wait: wait !== null && wait >= 0 ? wait : null,
    generating: generating !== null && generating > 0 ? generating : null,
    rate:
      output != null && generating !== null && generating > 0 && record.status === "succeeded"
        ? output / (generating / 1000)
        : null,
  };
}
