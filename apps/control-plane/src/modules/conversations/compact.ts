/**
 * Streams persist one chunk per token, so reading raw chunks makes a long run
 * unbounded. Consecutive delta chunks of one content id merge into one chunk
 * carrying the concatenated text: projection output is unchanged, and the
 * merged event keeps the run's start time while its seq moves to the run's
 * last raw seq so cursor paging neither skips nor repeats text.
 */
const DELTA_MERGE_LIMIT = 20000;
const DELTA_FIELDS: Record<
  string,
  { field: string; key: (chunk: Record<string, unknown>) => unknown }
> = {
  "text-delta": { field: "delta", key: (chunk) => chunk.id },
  "reasoning-delta": { field: "delta", key: (chunk) => chunk.id },
  "tool-input-delta": { field: "inputTextDelta", key: (chunk) => chunk.toolCallId },
};

type EventLike = {
  seq: number;
  chunk: Record<string, unknown>;
  observation?: unknown;
};

export function compactDeltaRuns<T extends EventLike>(events: T[]): T[] {
  const out: T[] = [];
  let open: { type: string; key: unknown; first: T; endSeq: number; text: string } | null = null;
  const flush = () => {
    if (!open) return;
    const spec = DELTA_FIELDS[open.type];
    out.push({
      ...open.first,
      seq: open.endSeq,
      chunk: { ...open.first.chunk, [spec.field]: open.text },
    });
    open = null;
  };
  for (const event of events) {
    const type = String(event.chunk.type ?? "");
    const spec = DELTA_FIELDS[type];
    const key = spec?.key(event.chunk);
    const mergeable =
      !!spec &&
      !event.observation &&
      key !== undefined &&
      typeof event.chunk[spec.field] === "string";
    if (
      mergeable &&
      open &&
      open.type === type &&
      key === open.key &&
      open.text.length < DELTA_MERGE_LIMIT
    ) {
      open = {
        type,
        key,
        first: open.first,
        endSeq: event.seq,
        text: open.text + String(event.chunk[spec.field]),
      };
      continue;
    }
    flush();
    if (mergeable)
      open = {
        type,
        key,
        first: event,
        endSeq: event.seq,
        text: String(event.chunk[spec.field]),
      };
    else out.push(event);
  }
  flush();
  return out;
}
