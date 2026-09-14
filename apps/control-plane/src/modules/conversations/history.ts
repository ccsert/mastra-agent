import { Message } from "@platform/contracts";
import { readUIMessageStream, type UIMessage, type UIMessageChunk, uiMessageChunkSchema } from "ai";

/** Restore the observable partial answer without representing it as a completed model response. */
export async function interruptedMessage(
  id: string,
  status: "failed" | "cancelled",
  errorCode: string | null,
  chunks: unknown[],
) {
  const message = await replayRunMessage(chunks);
  const parts = (message?.parts ?? []).map((part) => {
    if (part.type === "text" || part.type === "reasoning") return { ...part, state: "done" };
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "state" in part &&
      !["output-available", "output-error", "output-denied"].includes(String(part.state))
    )
      return { ...part, state: "output-error", errorText: "运行已结束，未记录此工具的完整结果" };
    return part;
  });
  return Message.parse({
    id: `assistant-${id}`,
    role: "assistant",
    parts,
    metadata: { runId: id, selectedSkills: [], runStatus: status, errorCode },
  });
}

export async function replayRunMessage(chunks: unknown[]) {
  let message: UIMessage | undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      for (const chunk of coalesceReplayDeltas(chunks)) {
        const checked = await uiMessageChunkSchema().validate?.(chunk);
        if (!checked?.success || ("transient" in checked.value && checked.value.transient))
          continue;
        if (["error", "abort", "finish"].includes(checked.value.type)) continue;
        controller.enqueue(checked.value);
      }
      controller.close();
    },
  });
  for await (const snapshot of readUIMessageStream({ stream, onError: () => {} }))
    message = snapshot;
  return message;
}

/** Replay has no typing animation; coalesce adjacent fragments while retaining the raw log. */
export function coalesceReplayDeltas(chunks: unknown[]) {
  const result: unknown[] = [];
  for (const value of chunks) {
    if (!value || typeof value !== "object") {
      result.push(value);
      continue;
    }
    const chunk = value as Record<string, unknown>;
    const prior = result.at(-1) as Record<string, unknown> | undefined;
    const key = chunk.type === "tool-input-delta" ? "inputTextDelta" : "delta";
    if (
      ["text-delta", "reasoning-delta", "tool-input-delta"].includes(String(chunk.type)) &&
      prior &&
      prior.type === chunk.type &&
      prior.id === chunk.id &&
      prior.toolCallId === chunk.toolCallId &&
      JSON.stringify(prior.providerMetadata) === JSON.stringify(chunk.providerMetadata) &&
      typeof prior[key] === "string" &&
      typeof chunk[key] === "string"
    ) {
      result[result.length - 1] = { ...prior, [key]: prior[key] + chunk[key] };
    } else result.push(value);
  }
  return result;
}
