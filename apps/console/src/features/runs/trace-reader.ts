import type { RunEvent, TraceTurn } from "@platform/sdk";
import { loadTraceTail } from "./trace-loading";

/** One queue per reader. Abort queued work as well as active fetches. */
export function createTraceReader(concurrency = 3) {
  let active = 0;
  const pending: { priority: number; start(): void }[] = [];
  const cached = new Map<string, RunEvent[]>();
  function pump() {
    pending.sort((a, b) => b.priority - a.priority);
    while (active < concurrency && pending.length) pending.shift()?.start();
  }
  return {
    read(
      projectId: string,
      turn: TraceTurn,
      signal: AbortSignal,
      progress: (events: RunEvent[]) => void,
      priority = turn.number,
    ): Promise<RunEvent[]> {
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = pending.indexOf(job);
          if (index >= 0) pending.splice(index, 1);
          reject(signal.reason);
        };
        const job = {
          priority,
          start() {
            signal.removeEventListener("abort", cancel);
            if (signal.aborted) return reject(signal.reason);
            active++;
            // Checkpoints identify immutable persisted events. Legacy endpoints
            // without a checkpoint must be reread when their status changes.
            const seed = turn.checkpoint ? (cached.get(turn.run.id) ?? []) : [];
            const through = turn.checkpoint?.lastSeq ?? Infinity;
            const base = turn.events.at(-1)?.seq ?? -1;
            const events = seed.filter((e) => e.seq > base && e.seq <= through);
            if (events.length) progress(events);
            const resume = events.length ? { ...turn, events: [events[events.length - 1]] } : turn;
            void loadTraceTail(projectId, resume, signal, (tail) => {
              const combined = [...events, ...tail];
              if (turn.checkpoint) cached.set(turn.run.id, combined);
              progress(combined);
            })
              .then((tail) => {
                const combined = [...events, ...tail];
                if (turn.checkpoint) cached.set(turn.run.id, combined);
                resolve(combined);
              }, reject)
              .finally(() => {
                active--;
                pump();
              });
          },
        };
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        pending.push(job);
        // Collect this render's jobs before choosing the newest/focused turn.
        queueMicrotask(pump);
      });
    },
  };
}
