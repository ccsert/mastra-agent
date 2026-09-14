import { createHash } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { Tool, ToolHooks } from "@mastra/core/tools";
import { z } from "@platform/contracts";
import type { TaskAccess } from "./durable.ts";

/** Hooks attached to an Agent disappear during upstream recover in 1.64.0.
 * Execute authorization/observation at the actual tool body on both paths. */
export function wrapToolBodies(
  tools: ToolsInput,
  hooks: ToolHooks,
  call?: TaskAccess,
  onUncertain?: (error: Error) => void,
) {
  for (const [toolName, value] of Object.entries(tools)) {
    if (!("execute" in value) || typeof value.execute !== "function") continue;
    const tool = value as Tool;
    if (!tool.execute) continue;
    const execute = tool.execute.bind(tool);
    tool.execute = async (input, context) => {
      const raw = context as
        | { agent?: { toolCallId?: string }; toolCallId?: string; writer?: { callId?: string } }
        | undefined;
      const id = raw?.agent?.toolCallId ?? raw?.toolCallId ?? raw?.writer?.callId;
      if (call && !id) throw new Error("TOOL_OUTCOME_UNKNOWN");
      let claimed = false,
        effectReturned = false;
      const hookContext = { toolName, input, context };
      const shortcut = await hooks.beforeToolCall?.(hookContext);
      try {
        if (call && id) {
          const inputHash = createHash("sha256")
            .update(JSON.stringify({ toolName, input }))
            .digest("hex");
          const receipt = z
            .object({
              cached: z.boolean(),
              output: z.unknown().optional(),
              errorCode: z.string().nullable().optional(),
            })
            .parse(await call({ operation: "tool-start", callId: id, inputHash }));
          if (receipt.cached) {
            if (receipt.errorCode) throw new Error(receipt.errorCode);
            await hooks.afterToolCall?.({ ...hookContext, output: receipt.output });
            return receipt.output;
          }
          claimed = true;
        }
        const output =
          shortcut?.proceed === false ? shortcut.output : await execute(input, context);
        effectReturned = true;
        if (claimed && call && id) await call({ operation: "tool-finish", callId: id, output });
        await hooks.afterToolCall?.({ ...hookContext, output });
        return output;
      } catch (error) {
        if (claimed && !effectReturned && call && id)
          await call({
            operation: "tool-finish",
            callId: id,
            output: null,
            errorCode: "TOOL_FAILED",
          }).catch(() => {});
        await hooks.afterToolCall?.({ ...hookContext, error });
        if (
          effectReturned ||
          (error instanceof Error && error.message === "TOOL_OUTCOME_UNKNOWN")
        ) {
          const unknown = new Error("TOOL_OUTCOME_UNKNOWN");
          onUncertain?.(unknown);
          throw unknown;
        }
        throw error;
      }
    };
  }
}
