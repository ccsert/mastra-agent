import { ExecutionJob, McpErrorCode, Message, SkillErrorCode } from "@platform/contracts";
import { createLogger } from "@platform/operations";
import { runtimeClient, type WorkerConfig, waitForPoll } from "../control-plane/index.ts";
import { executeJob } from "./execute.ts";

export async function runAgentWorker(config: WorkerConfig) {
  const post = runtimeClient(config);
  const log = config.logger ?? createLogger("runtime");
  while (!config.signal.aborted) {
    let job: ExecutionJob | null = null;
    try {
      const response = await post("/internal/runtime/claim", {});
      job = response.job ? ExecutionJob.parse(response.job) : null;
    } catch {
      await waitForPoll(1000, config.signal);
      continue;
    }
    if (!job) {
      await waitForPoll(500, config.signal);
      continue;
    }
    const current = job,
      controller = new AbortController(),
      executionSignal = AbortSignal.any([
        config.signal,
        controller.signal,
        AbortSignal.timeout(Math.max(1, current.deadline - Date.now())),
      ]);
    let seq = 0,
      cancelled = false;
    const heartbeat = setInterval(() => {
      void post(
        `/internal/runtime/runs/${current.runId}/heartbeat`,
        { leaseToken: current.leaseToken },
        executionSignal,
      )
        .then((result) => {
          if (result.cancelRequested) {
            cancelled = true;
            controller.abort();
          }
        })
        .catch(() => controller.abort());
    }, 4000);
    try {
      const message = await executeJob(
        current,
        executionSignal,
        async (chunk) => {
          await post(
            `/internal/runtime/runs/${current.runId}/events`,
            { leaseToken: current.leaseToken, seq: seq++, chunk },
            executionSignal,
          );
        },
        {
          skillSandboxImage: config.skillSandboxImage,
          skillAccess: (input, signal) =>
            post(
              `/internal/runtime/runs/${current.runId}/skills`,
              { ...input, leaseToken: current.leaseToken },
              signal,
            ),
          authorizeMcp: (toolId, signal) =>
            post(
              `/internal/runtime/runs/${current.runId}/mcp`,
              { leaseToken: current.leaseToken, toolId },
              signal,
            ),
          queryKnowledge: (knowledgeBaseId, vector, signal) =>
            post(
              `/internal/runtime/runs/${current.runId}/knowledge`,
              { leaseToken: current.leaseToken, knowledgeBaseId, vector },
              signal,
            ),
        },
      );
      await post(`/internal/runtime/runs/${current.runId}/finish`, {
        leaseToken: current.leaseToken,
        status: "succeeded",
        message: Message.parse(message),
      });
    } catch (error) {
      controller.abort();
      const mcpError = McpErrorCode.or(SkillErrorCode).safeParse(
        error instanceof Error ? error.message : "",
      );
      const errorCode =
        cancelled || config.signal.aborted
          ? "CANCELLED"
          : Date.now() >= current.deadline
            ? "TIMEOUT"
            : mcpError.success
              ? mcpError.data
              : "MODEL_ERROR";
      try {
        await post(
          `/internal/runtime/runs/${current.runId}/finish`,
          { leaseToken: current.leaseToken, status: cancelled ? "cancelled" : "failed", errorCode },
          AbortSignal.timeout(8000),
        );
      } catch {
        log({
          event: "completion_unacknowledged",
          runtimeId: config.runtimeId,
          jobId: current.runId,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
