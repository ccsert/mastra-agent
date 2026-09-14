import * as api from "@platform/sdk";
import { unwrap } from "../../shared/api";

export async function loadTraceTail(
  projectId: string,
  turn: api.TraceTurn,
  signal: AbortSignal,
  progress?: (events: api.RunEvent[]) => void,
) {
  const events: api.RunEvent[] = [];
  let after = turn.events.at(-1)?.seq ?? -1;
  const through = turn.checkpoint?.lastSeq;
  let publishedAt = 0;
  for (;;) {
    signal.throwIfAborted();
    if (through !== undefined && after >= through) break;
    const batch = await unwrap(
      api.listRunEvents({
        path: { projectId, id: turn.run.id },
        query: { after, through },
        signal,
      }),
      signal,
    );
    const next = batch.at(-1)?.seq ?? after;
    if (batch.length && next <= after) throw new Error("轨迹分页没有前进，请重试");
    events.push(...batch);
    after = next;
    if (progress && (publishedAt === 0 || performance.now() - publishedAt >= 250)) {
      signal.throwIfAborted();
      progress([...events]);
      publishedAt = performance.now();
    }
    if (batch.length < 500) break;
  }
  if (through !== undefined && after < through) throw new Error("轨迹事件不完整，请刷新后重试");
  return events;
}

/** Each turn keeps its own read checkpoint. New turns/stream events are excluded
 * from this export and appear on refresh; this is not a database-wide snapshot. */
export async function loadFullTrace(
  projectId: string,
  conversationId: string,
  signal: AbortSignal,
  progress: (loaded: number, total: number, snapshot: api.ConversationTrace) => void,
  readTail = (turn: api.TraceTurn, signal: AbortSignal) => loadTraceTail(projectId, turn, signal),
): Promise<api.ConversationTrace> {
  let before: number | undefined;
  let first: api.ConversationTrace | undefined;
  const turns = new Map<string, api.TraceTurn>();
  for (;;) {
    const page = await unwrap(
      api.getConversationTrace({
        path: { projectId, id: conversationId },
        query: { before, limit: 20 },
        signal,
      }),
      signal,
    );
    first ??= page;
    for (const turn of page.turns) {
      signal.throwIfAborted();
      const tail = turn.hasMoreEvents ? await readTail(turn, signal) : [];
      const events = [...new Map([...turn.events, ...tail].map((e) => [e.seq, e])).values()].sort(
        (a, b) => a.seq - b.seq,
      );
      if (turn.checkpoint && events.length !== turn.checkpoint.eventCount)
        throw new Error(`第 ${turn.number} 轮事件数量不一致，请刷新后重试`);
      turns.set(turn.run.id, { ...turn, events, hasMoreEvents: false });
      progress(turns.size, first.totalTurns, { ...first, turns: [...turns.values()] });
    }
    if (page.nextBefore === null) break;
    if (before !== undefined && page.nextBefore >= before)
      throw new Error("轨迹轮次分页没有前进，请重试");
    before = page.nextBefore;
  }
  if (turns.size !== first.totalTurns) throw new Error("会话轮次发生变化，请刷新后重试");
  return {
    ...first,
    turns: [...turns.values()].sort((a, b) => a.number - b.number),
    nextBefore: null,
  };
}
