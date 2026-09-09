import { runAgentWorker } from "./agents/index.ts";
import type { WorkerConfig } from "./control-plane/index.ts";
import { runKnowledgeWorker } from "./knowledge/index.ts";
import { runMcpWorker } from "./mcp/index.ts";
import { runWorkflowWorker } from "./workflows/index.ts";

export async function runWorker(config: WorkerConfig) {
  await Promise.all([
    runAgentWorker(config),
    runKnowledgeWorker(config),
    runMcpWorker(config),
    runWorkflowWorker(config),
  ]);
}
