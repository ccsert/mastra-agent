import { KnowledgeJob } from "@platform/contracts";
import { runtimeClient, type WorkerConfig, waitForPoll } from "../control-plane/index.ts";
import { executeKnowledgeJob } from "./knowledge.ts";

export async function runKnowledgeWorker(config: WorkerConfig) {
  const post = runtimeClient(config);
  while (!config.signal.aborted) {
    let job: KnowledgeJob | null = null;
    try {
      const response = await post("/internal/runtime/knowledge/claim", {});
      job = response.job ? KnowledgeJob.parse(response.job) : null;
    } catch {
      /* The Agent worker reports shared connection failures. */
    }
    if (!job) {
      await waitForPoll(750, config.signal);
      continue;
    }
    const current = job,
      path = `/internal/runtime/knowledge/${current.id}`,
      controller = new AbortController();
    const signal = AbortSignal.any([
      config.signal,
      controller.signal,
      AbortSignal.timeout(Math.max(1, current.deadline - Date.now())),
    ]);
    const heartbeat = setInterval(() => {
      void post(`${path}/heartbeat`, { leaseToken: current.leaseToken }, signal).catch(() =>
        controller.abort(),
      );
    }, 4000);
    try {
      const result = await executeKnowledgeJob(current, signal, post);
      await post(`${path}/finish`, result, signal);
    } catch (error) {
      controller.abort();
      const code = error instanceof Error ? error.message : "RUNTIME_ERROR";
      const errorCode =
        Date.now() >= current.deadline
          ? "TIMEOUT"
          : [
                "MODEL_ERROR",
                "INVALID_MODEL_RESPONSE",
                "DIMENSION_MISMATCH",
                "DOCUMENT_TOO_LARGE",
              ].includes(code)
            ? code
            : "RUNTIME_ERROR";
      try {
        await post(
          `${path}/finish`,
          { leaseToken: current.leaseToken, status: "failed", errorCode },
          AbortSignal.timeout(8000),
        );
      } catch {
        /* A deleted document or expired lease is finalized by the control plane. */
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
