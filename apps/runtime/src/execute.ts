import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { toAISdkStream } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import type { ExecutionJob } from "@platform/contracts";
import {
  convertToModelMessages,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  validateUIMessages,
} from "ai";
import Ajv from "ajv";

export async function executeJob(
  job: ExecutionJob,
  signal: AbortSignal,
  onChunk: (chunk: UIMessageChunk) => Promise<void>,
) {
  const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
  const tools = Object.fromEntries(
    job.snapshot.tools.map((definition) => {
      const validateInput = ajv.compile(definition.inputSchema),
        validateOutput = ajv.compile(definition.outputSchema);
      const tool = createTool({
        id: `${definition.id}:v1`,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        execute: async (input) => {
          signal.throwIfAborted();
          if (!validateInput(input)) throw new Error("TOOL_INPUT_INVALID");
          let output: unknown;
          if (definition.kind === "sum") {
            const values = (input as { values: number[] }).values;
            output = { total: values.reduce((a, b) => a + b, 0) };
          } else {
            const url = new URL(definition.url);
            for (const [key, value] of Object.entries(input as Record<string, unknown>))
              url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
            const token = job.credentials.toolTokens[definition.id];
            const response = await fetch(url, {
              method: "GET",
              redirect: "error",
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!response.ok) throw new Error("TOOL_HTTP_ERROR");
            const reader = response.body?.getReader();
            if (!reader) throw new Error("TOOL_EMPTY_RESPONSE");
            let bytes = 0,
              body = "";
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 65536) {
                await reader.cancel();
                throw new Error("TOOL_RESULT_TOO_LARGE");
              }
              body += decoder.decode(value, { stream: true });
            }
            body += decoder.decode();
            output = JSON.parse(body);
          }
          if (!validateOutput(output)) throw new Error("TOOL_OUTPUT_INVALID");
          return output;
        },
      });
      return [definition.name, tool];
    }),
  );
  const model = createOpenAICompatible({
    name: "platform",
    baseURL: job.snapshot.model.baseUrl.replace(/\/$/, ""),
    apiKey: job.credentials.modelApiKey || undefined,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  }).chatModel(job.snapshot.model.modelId);
  const agent = new Agent({
    id: job.runId,
    name: job.snapshot.agent.name,
    instructions: job.snapshot.agent.instructions,
    model,
    tools,
  });
  const history = await validateUIMessages({ messages: job.messages });
  const messages = await convertToModelMessages(history);
  // Platform events carry approved content; disable upstream payload logging.
  const mastra = new Mastra({ agents: { runner: agent }, logger: false });
  const result = await mastra.getAgent("runner").stream(messages, {
    maxSteps: job.snapshot.agent.maxSteps,
    abortSignal: signal,
    modelSettings: { maxOutputTokens: 4096, temperature: 0.3 },
  });
  const stream = toAISdkStream(result, {
    from: "agent",
    version: "v7",
    sendReasoning: false,
    onError: () => "模型或工具调用失败，请检查配置与运行记录",
  });
  const [events, assembled] = stream.tee();
  let finalMessage: UIMessage | undefined,
    streamFailed = false;
  const assemble = (async () => {
    for await (const message of readUIMessageStream({
      stream: assembled,
      onError: () => {
        streamFailed = true;
      },
    }))
      finalMessage = message;
  })();
  try {
    for await (const chunk of events) {
      if (chunk.type === "error") streamFailed = true;
      await onChunk(chunk);
    }
    await assemble;
  } catch (error) {
    await assembled.cancel().catch(() => {});
    throw error;
  }
  if (streamFailed || !finalMessage) throw new Error("MODEL_ERROR");
  signal.throwIfAborted();
  return finalMessage;
}
