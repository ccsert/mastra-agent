import { createHash } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { Tool, ToolHooks } from "@mastra/core/tools";
import { z } from "@platform/contracts";
import type { TaskAccess } from "./durable.ts";

/** The conversation's write-tool mode, carried on every claimed job. */
export type ApprovalPolicyName = "readonly" | "ask" | "auto";

/** Tools whose calls are governed by the conversation's write-tool mode. */
export type WriteGate = {
  /** Registered tool names declared as writing business data. */
  writes: ReadonlySet<string>;
  policy: ApprovalPolicyName;
  /** Resolves to the person's verdict; never decides on its own. Only used
   * under the `ask` policy. */
  decide(callId: string, toolName: string): Promise<"approved" | "denied" | "expired">;
};

/** What an ungated call returns to the model instead of a result. The message
 * names the current mode so the model stops offering the write instead of
 * retrying it. */
function refusal(policy: ApprovalPolicyName, verdict: "denied" | "expired" | "readonly") {
  if (policy === "readonly")
    return {
      denied: true,
      reason: "policy-readonly",
      message:
        "本会话的权限模式是「仅可查看」：写入工具不会执行，也没有发起确认。请停止尝试写入，改用只读方式回答，或请用户把权限模式切换到「确认后修改」。",
    };
  if (verdict === "expired")
    return {
      denied: true,
      reason: "expired",
      message:
        "这次写入操作等待用户确认超时，未获答复，因此没有执行。可以说明情况并请用户重新发起。",
    };
  return {
    denied: true,
    reason: "user-denied",
    message:
      "用户拒绝执行此写入工具，本次调用未执行。不要用相同参数重试；可以说明情况、改用只读方式，或请用户改变决定。",
  };
}

/** Hooks attached to an Agent disappear during upstream recover in 1.64.0.
 * Execute authorization/observation at the actual tool body on both paths. */
export function wrapToolBodies(
  tools: ToolsInput,
  hooks: ToolHooks,
  call?: TaskAccess,
  onUncertain?: (error: Error) => void,
  gate?: WriteGate,
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
        // The gate runs before the receipt is claimed: a refused call has no
        // effect to record, and the model learns why without a failed receipt.
        if (gate && id && gate.writes.has(toolName) && shortcut?.proceed !== false) {
          // `readonly` refuses deterministically without a prompt — nobody is
          // asked, so nobody's time is spent on a call that cannot run.
          const verdict =
            gate.policy === "readonly"
              ? "readonly"
              : gate.policy === "auto"
                ? undefined
                : await gate.decide(id, toolName);
          if (verdict !== undefined && verdict !== "approved") {
            const output = refusal(gate.policy, verdict);
            await hooks.afterToolCall?.({ ...hookContext, output });
            return output;
          }
        }
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
