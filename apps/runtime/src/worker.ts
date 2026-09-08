import { runAgentWorker } from "./agent-worker.ts";
import type { WorkerConfig } from "./control-client.ts";
import { runKnowledgeWorker } from "./knowledge-worker.ts";
import { runMcpWorker } from "./mcp-worker.ts";
import { runWorkflowWorker } from "./workflow-worker.ts";

export async function runWorker(config: WorkerConfig) {
  await Promise.all([
    runAgentWorker(config),
    runKnowledgeWorker(config),
    runMcpWorker(config),
    runWorkflowWorker(config),
  ]);
}
