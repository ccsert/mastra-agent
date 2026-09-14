import { randomUUID } from "node:crypto";
import { ExecutionJob } from "../../packages/contracts/src/index.ts";

export function agentJob(baseUrl = "http://127.0.0.1:1234/v1") {
  const id = randomUUID();
  return ExecutionJob.parse({
    runId: randomUUID(),
    conversationId: randomUUID(),
    leaseToken: "test-lease",
    deadline: Date.now() + 120000,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Build a webpage. Keep the title violet-317." }],
      },
    ],
    credentials: { modelApiKey: "fixture-key", toolTokens: {} },
    snapshot: {
      agent: {
        name: "fixture",
        instructions: "Use the provided tools and report evidence.",
        modelId: id,
        toolIds: [],
        maxSteps: 80,
        executionLimits: { maxTokens: 2000000, maxModelCalls: 100 },
      },
      model: {
        id,
        projectId: randomUUID(),
        name: "fixture",
        baseUrl,
        modelId: "fixture-chat",
        provider: "openai-compatible",
        hasCredential: true,
        createdAt: new Date().toISOString(),
        capabilities: { toolUse: true, vision: true },
      },
      tools: [],
      adapterVersion: "mastra-agent-v1",
    },
  });
}
