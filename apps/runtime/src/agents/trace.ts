import { ModelRequestTiming, traceEventNames, z } from "@platform/contracts";
import type { UIMessageChunk } from "ai";

// Record the actual OpenAI-compatible request body after Mastra applies its
// workspace/Skill context. Transport headers and credentials are never copied.
const requestBody = z.object({
  model: z.string(),
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stream_options: z.record(z.string(), z.unknown()).optional(),
});

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Records both edges of every model request at the provider fetch boundary.
 *
 * Requests keep their established `data-model-request` shape. Responses add
 * transport-level facts only: the body is counted and passed through, never
 * parsed, and no request or response header is copied. `firstByteMs` is the first
 * response byte rather than a token-level first-token latency, and a request that
 * never produced a response is reported as `failed` instead of being omitted.
 */
export function tracedModelFetch(
  onChunk: (chunk: UIMessageChunk) => Promise<void>,
  send: typeof fetch = fetch,
  now: () => number = Date.now,
  currentStep?: () => number | undefined,
  initialRequestIndex = 0,
): typeof fetch {
  let requestIndex = initialRequestIndex;
  // A trace event must never break the model stream it describes: validation and
  // delivery failures are dropped here rather than surfacing inside a body pull.
  const report = async (timing: ModelRequestTiming) => {
    try {
      await onChunk({
        type: traceEventNames.modelResponse,
        transient: true,
        data: ModelRequestTiming.parse(timing),
      });
    } catch {
      // An unrecordable observation stays unrecorded; it is never replaced by a guess.
    }
  };
  /**
   * Observes the body by pulling through it one chunk at a time. Backpressure is
   * preserved, so a slow reader cannot make the runtime buffer a whole completion
   * just to measure it, and a cancelled body is reported instead of looking complete.
   */
  const observe = async (response: Response, index: number, startedAt: number) => {
    const responseAt = now();
    let firstByteAt: number | null = null,
      responseBytes = 0,
      reported = false;
    // Awaited at every exit so the record is flushed before the run can finish.
    const complete = async (outcome: ModelRequestTiming["outcome"]) => {
      if (reported) return;
      reported = true;
      const completedAt = now();
      await report({
        requestIndex: index,
        httpStatus: response.status,
        startedAt: iso(startedAt),
        responseAt: iso(responseAt),
        firstByteAt: firstByteAt === null ? null : iso(firstByteAt),
        completedAt: iso(completedAt),
        durationMs: Math.max(0, completedAt - startedAt),
        firstByteMs: firstByteAt === null ? null : Math.max(0, firstByteAt - startedAt),
        responseBytes,
        outcome,
      });
    };
    if (!response.body) {
      await complete("completed");
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            await complete("completed");
            return;
          }
          if (firstByteAt === null) firstByteAt = now();
          responseBytes += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          await complete("incomplete");
          throw error;
        }
      },
      async cancel(reason) {
        // A cancelled body is recorded as incomplete; it is never presented as complete.
        await complete("incomplete");
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return async (input, init) => {
    const startedAt = now();
    // The counter marks transport calls, so a response can always be joined to the
    // request that caused it even when a body was not a plain JSON string.
    const index = ++requestIndex;
    if (typeof init?.body === "string") {
      let request: unknown;
      try {
        const parsed = requestBody.safeParse(JSON.parse(init.body));
        if (parsed.success) request = parsed.data;
      } catch {
        // A non-JSON string body is not treated as a model request.
      }
      if (request)
        await onChunk({
          type: traceEventNames.modelRequest,
          transient: true,
          data: {
            requestIndex: index,
            ...(currentStep?.() !== undefined ? { stepIndex: currentStep?.() } : {}),
            preparedAt: iso(startedAt),
            source: "runtime-model-request",
            request,
          },
        });
    }
    let response: Response;
    try {
      response = await send(input, { ...init, redirect: "error" });
    } catch (error) {
      const completedAt = now();
      // A request that never got a response is reported as failed, not omitted.
      await report({
        requestIndex: index,
        httpStatus: null,
        startedAt: iso(startedAt),
        responseAt: null,
        firstByteAt: null,
        completedAt: iso(completedAt),
        durationMs: Math.max(0, completedAt - startedAt),
        firstByteMs: null,
        responseBytes: 0,
        outcome: "failed",
      });
      throw error;
    }
    return observe(response, index, startedAt);
  };
}
