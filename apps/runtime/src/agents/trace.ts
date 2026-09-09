import { z } from "@platform/contracts";
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
});

export function tracedModelFetch(
  onChunk: (chunk: UIMessageChunk) => Promise<void>,
  send: typeof fetch = fetch,
): typeof fetch {
  let requestIndex = 0;
  return async (input, init) => {
    if (typeof init?.body === "string") {
      const parsed = requestBody.safeParse(JSON.parse(init.body));
      if (parsed.success) {
        await onChunk({
          type: "data-model-request",
          transient: true,
          data: {
            requestIndex: ++requestIndex,
            preparedAt: new Date().toISOString(),
            source: "runtime-model-request",
            request: parsed.data,
          },
        });
      }
    }
    return send(input, { ...init, redirect: "error" });
  };
}
