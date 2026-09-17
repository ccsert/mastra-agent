import {
  AgentLimitError,
  ExecutionJob,
  McpErrorCode,
  Message,
  SkillErrorCode,
  TaskFeedback,
} from "@platform/contracts";
import { createLogger } from "@platform/operations";
import { runtimeClient, type WorkerConfig, waitForPoll } from "../control-plane/index.ts";
import { executeJob } from "./execute.ts";

/** Provider-specific overflow wording, matched down the cause chain so
 * wrapped SDK errors still classify instead of collapsing to MODEL_ERROR. */
function isContextOverflow(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (
      /maximum context length|context[_ -]?(length|window)|prompt is too long|exceeds the maximum (number of )?tokens/i.test(
        current.message,
      )
    )
      return true;
    current = current.cause;
  }
  return false;
}

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
    let seq = job.nextEventSeq,
      cancelled = false;
    // User cancellation stops execution but gives terminal child observations a
    // bounded delivery window before the root run is finalized.
    const eventSignal = AbortSignal.any([
      config.signal,
      AbortSignal.timeout(Math.max(1, current.deadline - Date.now()) + 8000),
    ]);
    let delivery = Promise.resolve();
    // A fenced operation can observe cancellation before the next heartbeat.
    // Propagate it immediately to running and queued children, retaining their terminal events.
    const taskPost = async (input: Record<string, unknown>) => {
      try {
        return await post(
          `/internal/runtime/runs/${current.runId}/task`,
          { ...input, leaseToken: current.leaseToken },
          executionSignal,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "CANCELLED") {
          cancelled = true;
          controller.abort();
        }
        throw error;
      }
    };
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
        (chunk) => {
          // Stamped when the runtime produces the event, not when the queued
          // delivery happens to reach the control plane.
          const occurredAt = new Date().toISOString();
          // Model request capture and stream consumption can emit concurrently.
          // Preserve the append protocol's contiguous sequence at the network boundary.
          delivery = delivery.then(async () => {
            await post(
              `/internal/runtime/runs/${current.runId}/events`,
              { leaseToken: current.leaseToken, seq: seq++, occurredAt, chunk },
              eventSignal,
            );
          });
          return delivery;
        },
        {
          platformAssistant: current.systemAssistant
            ? (tool, input, toolCallId) =>
                post(
                  `/internal/runtime/runs/${current.runId}/assistant`,
                  { tool, input, toolCallId, leaseToken: current.leaseToken },
                  executionSignal,
                )
            : undefined,
          taskWorkspaceRoot: config.taskWorkspaceRoot,
          readFeedback: async () => {
            const response = await taskPost({ operation: "feedback" });
            const items = TaskFeedback.array().parse(response.feedback);
            const unread = items.filter((item) => !item.readAt).map((item) => item.id);
            if (unread.length) await taskPost({ operation: "feedback-read", ids: unread });
            return items;
          },
          taskSandboxImage: config.taskSandboxImage,
          uploadArtifact: (input) => taskPost({ ...input, operation: "artifact" }),
          task: (input) => taskPost(input),
          reserveModel: (input) => taskPost({ ...input, operation: "reserve" }).then(() => {}),
          settleModel: (input) => taskPost({ ...input, operation: "settle" }).then(() => {}),
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
      await delivery.catch(() => {});
      const mcpError = McpErrorCode.or(SkillErrorCode)
        .or(AgentLimitError)
        .safeParse(error instanceof Error ? error.message : "");
      const errorCode =
        cancelled || config.signal.aborted
          ? "CANCELLED"
          : Date.now() >= current.deadline
            ? "TIMEOUT"
            : isContextOverflow(error)
              ? "CONTEXT_WINDOW_EXCEEDED"
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
