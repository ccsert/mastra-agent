import { ModelRequestTiming, type RunUsage, traceEventNames } from "@platform/contracts";
import type { UIMessageChunk } from "ai";

/** Replayed provider-native request body recorded by a previous run. */
export interface CompactionPrefix {
  model: string;
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  toolChoice?: unknown;
  temperature?: number;
  maxTokens?: number;
}

export interface PrefixSummary {
  text: string;
  usage: RunUsage["usage"];
  finishReason: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Provider-reported usage; a metric the provider omits stays null, never zero. */
function usageOf(reported: Record<string, unknown> | undefined): RunUsage["usage"] {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const details = (key: string) => {
    const value = reported?.[key];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  };
  return {
    inputTokens: count(reported?.prompt_tokens),
    outputTokens: count(reported?.completion_tokens),
    totalTokens: count(reported?.total_tokens),
    reasoningTokens: count(details("completion_tokens_details")?.reasoning_tokens),
    cachedInputTokens: count(details("prompt_tokens_details")?.cached_tokens),
  };
}

/**
 * Summarizes by continuing the newest recorded model request verbatim and
 * appending the compaction instruction as the final user message. The
 * auxiliary call is a genuine prefix of the conversation the provider already
 * processed, so its prompt cache is reused instead of invalidating the whole
 * body — only the instruction and the summary output are new tokens.
 */
export async function summarizeWithPrefix(options: {
  prefix: CompactionPrefix;
  instruction: string;
  stepIndex: number;
  requestIndex: number;
  baseUrl: string;
  apiKey: string;
  signal: AbortSignal;
  send?: typeof fetch;
  emit: (chunk: UIMessageChunk) => Promise<void>;
}): Promise<PrefixSummary> {
  const { prefix, instruction, stepIndex, requestIndex, baseUrl, apiKey, signal, emit } = options;
  const send = options.send ?? fetch;
  const body: Record<string, unknown> = {
    model: prefix.model,
    messages: [...prefix.messages, { role: "user", content: instruction }],
    ...(prefix.tools ? { tools: prefix.tools } : {}),
    ...(prefix.toolChoice === undefined ? {} : { tool_choice: prefix.toolChoice }),
    ...(prefix.temperature === undefined ? {} : { temperature: prefix.temperature }),
    // The recorded cap may target a normal answer; a summary needs room, and
    // the cap sits outside the cached prompt so changing it costs nothing.
    max_tokens: Math.max(8192, prefix.maxTokens ?? 0),
    stream: true,
    stream_options: { include_usage: true },
  };
  const startedAt = Date.now();
  // The trace records exactly what was sent, including the replayed prefix.
  await emit({
    type: traceEventNames.modelRequest,
    transient: true,
    data: {
      requestIndex,
      stepIndex,
      preparedAt: iso(startedAt),
      source: "runtime-model-request",
      request: body,
    },
  });
  let firstByteAt: number | null = null,
    responseAt: number | null = null,
    responseBytes = 0,
    reported = false;
  const timing = async (outcome: ModelRequestTiming["outcome"], httpStatus: number | null) => {
    if (reported) return;
    reported = true;
    const completedAt = Date.now();
    try {
      await emit({
        type: traceEventNames.modelResponse,
        transient: true,
        data: ModelRequestTiming.parse({
          requestIndex,
          httpStatus,
          startedAt: iso(startedAt),
          responseAt: responseAt === null ? null : iso(responseAt),
          firstByteAt: firstByteAt === null ? null : iso(firstByteAt),
          completedAt: iso(completedAt),
          durationMs: Math.max(0, completedAt - startedAt),
          firstByteMs: firstByteAt === null ? null : Math.max(0, firstByteAt - startedAt),
          responseBytes,
          outcome,
        }),
      });
    } catch {
      // An unrecordable observation stays unrecorded; it never replaces the result.
    }
  };
  let response: Response;
  try {
    response = await send(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
  } catch (error) {
    await timing("failed", null);
    throw error;
  }
  responseAt = Date.now();
  if (!response.ok || !response.body) {
    await timing("failed", response.status);
    throw new Error("MODEL_ERROR");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    text = "",
    finishReason: string | null = null,
    usage = usageOf(undefined),
    outcome: ModelRequestTiming["outcome"] = "incomplete";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        outcome = "completed";
        break;
      }
      if (firstByteAt === null) firstByteAt = Date.now();
      responseBytes += value.byteLength;
      pending += decoder.decode(value, { stream: true });
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const frame = JSON.parse(payload) as {
            choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
            usage?: Record<string, unknown>;
          };
          const content = frame.choices?.[0]?.delta?.content;
          if (typeof content === "string") text += content;
          const reason = frame.choices?.[0]?.finish_reason;
          if (typeof reason === "string") finishReason = reason;
          if (frame.usage) usage = usageOf(frame.usage);
        } catch {
          // Keep-alive and non-JSON frames carry no summary content.
        }
      }
    }
  } catch (error) {
    await timing("incomplete", response.status);
    throw error;
  }
  await timing(outcome, response.status);
  signal.throwIfAborted();
  // A truncated checkpoint would silently drop material: it never commits.
  if (finishReason === "length") throw new Error("MODEL_ERROR");
  return { text, usage, finishReason };
}
