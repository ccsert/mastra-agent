import { setTimeout } from "node:timers/promises";
import { createTool } from "@mastra/core/tools";
import {
  AgentAppReceipt,
  type AssistantToolRequest,
  AssistantUiReceipt,
  assistantToolDefinitions,
  type z,
} from "@platform/contracts";
export type AssistantAccess = (
  tool: z.infer<typeof AssistantToolRequest>["tool"],
  input: Record<string, unknown>,
  toolCallId: string,
) => Promise<unknown>;
export function createAssistantTools(
  call: AssistantAccess,
  callId: (context: unknown) => string,
  signal?: AbortSignal,
) {
  return Object.fromEntries(
    Object.entries(assistantToolDefinitions).map(([id, definition]) => [
      id,
      createTool({
        id,
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input, context) => {
          const toolCallId = callId(context);
          let result = await call(definition.kind, input, toolCallId);
          if (definition.kind !== "ui" && definition.kind !== "app") return result;
          const until = Date.now() + 35000;
          while (true) {
            const receipt =
              definition.kind === "app"
                ? AgentAppReceipt.safeParse(result)
                : AssistantUiReceipt.safeParse(result);
            if (!receipt.success || !["pending", "executing"].includes(receipt.data.status))
              return result;
            if (Date.now() > until)
              return {
                ...receipt.data,
                status: definition.kind === "app" ? "unknown" : "failed",
                result: {
                  message: "未在时限内收到页面回执，结果不可确认，请先 inspect，不要重复执行",
                },
              };
            await setTimeout(500, undefined, { signal });
            result = await call(
              definition.kind,
              { operation: "result", actionId: receipt.data.id },
              toolCallId,
            );
          }
        },
      }),
    ]),
  );
}
