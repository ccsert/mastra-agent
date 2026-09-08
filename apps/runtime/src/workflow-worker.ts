import { canonicalJson, ExecutionJob, Tool, WorkflowRuntimeJob, z } from "@platform/contracts";
import { executeJob } from "./execute.ts";
import { executePlatformTool } from "./tool-execute.ts";
import { runtimeClient, type WorkerConfig } from "./worker.ts";
import { executeWorkflow } from "./workflow-execute.ts";
import { generateWorkflowCandidate } from "./workflow-generate.ts";

const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal.addEventListener("abort", done, { once: true });
  });
export async function runWorkflowWorker(config: WorkerConfig) {
  const post = runtimeClient(config);
  while (!config.signal.aborted) {
    let job: WorkflowRuntimeJob;
    try {
      const result = await post("/internal/runtime/workflows/claim", {});
      if (!result.job) {
        await pause(config.signal);
        continue;
      }
      job = WorkflowRuntimeJob.parse(result.job);
    } catch {
      await pause(config.signal);
      continue;
    }
    const stop = new AbortController(),
      signal = AbortSignal.any([
        config.signal,
        stop.signal,
        AbortSignal.timeout(Math.max(1, job.deadline - Date.now())),
      ]);
    const path = `/internal/runtime/workflows/${job.id}`,
      lease = { leaseToken: job.leaseToken };
    const heartbeat = setInterval(() => {
      void post(`${path}/heartbeat`, lease, signal).catch(() => stop.abort());
    }, 4000);
    try {
      if (job.kind === "generate") {
        const result = await generateWorkflowCandidate(job, signal);
        await post(`${path}/finish`, { ...lease, status: "succeeded", ...result }, signal);
      } else {
        await executeWorkflow(job.snapshot, job.input, signal, {
          start: async (node, input) => {
            const binding = await post(`${path}/nodes/${node.id}/start`, lease, signal);
            if (canonicalJson(binding.input) !== canonicalJson(input))
              throw new Error("WORKFLOW_INVALID");
            return binding;
          },
          invoke: async (node, input, rawBinding) => {
            const binding = z
              .object({
                tool: Tool.optional(),
                token: z.string().optional(),
                agentJob: ExecutionJob.optional(),
              })
              .parse(rawBinding);
            const nodePath = `${path}/nodes/${node.id}`;
            if (node.type === "tool" && binding.tool) {
              const tool = binding.tool;
              return executePlatformTool(
                binding.tool,
                input,
                signal,
                binding.token ?? "",
                async () => {
                  try {
                    return z
                      .object({ url: z.string(), bearerToken: z.string() })
                      .parse(await post(`${nodePath}/mcp`, { ...lease, toolId: tool.id }, signal));
                  } catch {
                    throw new Error("MCP_AUTH_DENIED");
                  }
                },
              );
            }
            if (node.type !== "agent" || !binding.agentJob) throw new Error("WORKFLOW_INVALID");
            const message = await executeJob(binding.agentJob, signal, async () => {}, {
              authorizeMcp: (toolId, signal) =>
                post(`${nodePath}/mcp`, { ...lease, toolId }, signal),
              queryKnowledge: (knowledgeBaseId, vector, signal) =>
                post(`${nodePath}/knowledge`, { ...lease, knowledgeBaseId, vector }, signal),
            });
            const sources = message.parts.flatMap((part) =>
              "output" in part &&
              part.output &&
              typeof part.output === "object" &&
              "sources" in part.output &&
              Array.isArray(part.output.sources)
                ? part.output.sources
                : [],
            );
            return {
              text: message.parts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
              sources,
            };
          },
          finish: async (node, output, error) => {
            await post(
              `${path}/nodes/${node.id}/finish`,
              {
                ...lease,
                status: error ? "failed" : "succeeded",
                ...(error ? { errorCode: error.message } : { output }),
              },
              error ? AbortSignal.timeout(8000) : signal,
            );
          },
        });
        await post(`${path}/finish`, { ...lease, status: "succeeded" }, signal);
      }
    } catch (error) {
      const errorCode =
        Date.now() >= job.deadline
          ? "TIMEOUT"
          : config.signal.aborted
            ? "CANCELLED"
            : error instanceof Error
              ? error.message
              : "WORKFLOW_FAILED";
      try {
        await post(
          `${path}/finish`,
          { ...lease, status: "failed", errorCode },
          AbortSignal.timeout(8000),
        );
      } catch {
        /* A cancelled or expired job is already fenced by the control plane. */
      }
    } finally {
      clearInterval(heartbeat);
      stop.abort();
    }
  }
}
