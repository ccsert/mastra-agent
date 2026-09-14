import { ExecutionLimits, type ReleaseSnapshot } from "@platform/contracts";

export type ModelReservation = { requestId: string; estimatedTokens: number };
export type ModelSettlement = { requestId: string; actualTokens: number };
/** Shared by the root and all children; retries consume a new request too. The
 * estimate is a conservative guard, never presented as provider-reported usage. */
export function createRunBudget(
  snapshot: ReleaseSnapshot,
  reserve?: (input: ModelReservation) => Promise<void>,
  settle?: (input: ModelSettlement) => Promise<void>,
) {
  const limits = ExecutionLimits.parse(snapshot.agent.executionLimits ?? {});
  let calls = 0,
    reserved = 0,
    failure: Error | undefined;
  return {
    limits,
    get failure() {
      return failure;
    },
    async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      if (failure) throw failure;
      const body = typeof init?.body === "string" ? init.body : "";
      // UTF-8 bytes is an upper guard for supported text tokenizers; image token
      // accounting remains a reservation, with actual usage recorded separately.
      let imageCount = 0;
      const textBody = body.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, () => {
        imageCount++;
        return "[image]";
      });
      // Encoded PNG bytes are not text tokens. Reserve per image separately;
      // provider-reported usage settles this guard after the response.
      const estimate =
        new TextEncoder().encode(textBody).length + imageCount * 32768 + limits.maxOutputTokens;
      calls++;
      reserved += estimate;
      if (calls > limits.maxModelCalls || reserved > limits.maxTokens) {
        failure = new Error(calls > limits.maxModelCalls ? "MODEL_CALL_LIMIT" : "TOKEN_BUDGET");
        throw failure;
      }
      try {
        const requestId = crypto.randomUUID();
        await reserve?.({ requestId, estimatedTokens: estimate });
        const response = await fetch(input, init);
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
          return response;
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let pending = "",
          actual: number | undefined,
          finished = false;
        const complete = async () => {
          if (finished) return;
          finished = true;
          if (actual === undefined) return;
          await settle?.({ requestId, actualTokens: actual });
          reserved = Math.max(0, reserved - estimate + actual);
        };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                await complete();
                controller.close();
                return;
              }
              pending += decoder.decode(next.value, { stream: true });
              let end = pending.indexOf("\n");
              while (end >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                end = pending.indexOf("\n");
                if (!line.startsWith("data:") || line.length > 65536) continue;
                try {
                  const usage = JSON.parse(line.slice(5)).usage;
                  if (
                    typeof usage?.total_tokens === "number" &&
                    Number.isSafeInteger(usage.total_tokens) &&
                    usage.total_tokens >= 0
                  )
                    actual = usage.total_tokens;
                } catch {
                  /* Other SSE frames carry no usage. */
                }
              }
              if (pending.length > 65536) pending = "";
              controller.enqueue(next.value);
            } catch (error) {
              failure = error instanceof Error ? error : new Error("BUDGET_UNAVAILABLE");
              controller.error(error);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            await complete();
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error("BUDGET_UNAVAILABLE");
        throw failure;
      }
    },
  };
}
export type RunBudget = ReturnType<typeof createRunBudget>;
