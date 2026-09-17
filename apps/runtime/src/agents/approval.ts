import { ToolApprovalObservation, traceEventNames } from "@platform/contracts";
import type { UIMessageChunk } from "ai";
import type { TaskAccess } from "./durable.ts";

export type ApprovalVerdict = "approved" | "denied" | "expired";

/** Wait budget mirrors the control plane's gate TTL; polling after expiry would
 * only re-read a verdict nobody can change anymore. */
const MAX_WAIT_MS = 10 * 60 * 1000;
const FIRST_POLL_MS = 400;
const MAX_POLL_MS = 3000;

/** A pause that must end even when the platform stops answering. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * Opens the human confirmation gate for one write-tool call and waits for a
 * person to answer. The runtime never decides on its own: an unanswered gate
 * ends as `expired`, which the caller treats as "did not run".
 */
export async function awaitApproval(input: {
  callId: string;
  toolName: string;
  call: TaskAccess;
  emit: (chunk: UIMessageChunk) => Promise<void>;
  signal: AbortSignal;
}): Promise<ApprovalVerdict> {
  const { callId, toolName, call, emit, signal } = input;
  const observe = async (approval: unknown) => {
    try {
      await emit({
        type: traceEventNames.toolApproval,
        transient: true,
        data: approval as Record<string, unknown>,
      });
    } catch {
      // An unrecordable observation never blocks or reverses the decision.
    }
  };
  const opened = ToolApprovalObservation.parse(
    await call({ operation: "approval-request", callId, toolName }),
  );
  await observe(opened);
  if (opened.status !== "pending") return opened.status;
  const startedAt = Date.now();
  let delay = FIRST_POLL_MS;
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() - startedAt > MAX_WAIT_MS) return "expired";
    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.5), MAX_POLL_MS);
    const current = ToolApprovalObservation.parse(
      await call({ operation: "approval-poll", callId }),
    );
    if (current.status === "pending") continue;
    await observe(current);
    return current.status;
  }
}
