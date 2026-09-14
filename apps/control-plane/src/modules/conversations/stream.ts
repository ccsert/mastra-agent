import type { Principal } from "@platform/contracts";
import { createUIMessageStreamResponse, type UIMessageChunk, uiMessageChunkSchema } from "ai";
import type { Conversations } from "./conversations.ts";

/** Both POST and reconnect replay the same committed log; disconnect never re-executes work. */
export function conversationStream(
  conversations: Conversations,
  actor: Principal,
  projectId: string,
  run: Awaited<ReturnType<Conversations["run"]>>,
) {
  let stopped = false,
    after = -1,
    errorSent = false,
    finish: Extract<UIMessageChunk, { type: "finish" }> | undefined;
  const stream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        // A deterministic ID joins restored and streamed messages without duplication.
        controller.enqueue({
          type: "start",
          messageId: `assistant-${run.id}`,
          messageMetadata: { runId: run.id, selectedSkills: run.selectedSkills },
        });
        while (!stopped) {
          const current = await conversations.run(actor, projectId, run.id);
          const events = await conversations.events(actor, projectId, run.id, after);
          if (stopped) return;
          for (const event of events) {
            const checked = await uiMessageChunkSchema().validate?.(event.chunk);
            if (!checked?.success) throw new Error("Invalid stream event");
            const chunk = checked.value;
            if (chunk.type !== "start" && chunk.type !== "finish") controller.enqueue(chunk);
            if (chunk.type === "error") errorSent = true;
            if (chunk.type === "finish") finish = chunk;
            after = event.seq;
          }
          if (!["queued", "running"].includes(current.status) && events.length < 500) {
            controller.enqueue({
              type: "message-metadata",
              messageMetadata: {
                runId: current.id,
                runStatus: current.status,
                errorCode: current.errorCode,
              },
            });
            if (current.status === "failed" && !errorSent)
              controller.enqueue({
                type: "error",
                errorText: `运行失败：${current.errorCode ?? "UNKNOWN"}`,
              });
            if (current.status === "cancelled") controller.enqueue({ type: "abort" });
            // Emit finish only after the transaction that persists the result commits.
            controller.enqueue({
              type: "finish",
              ...(current.status === "succeeded"
                ? (finish ?? { finishReason: "stop" as const })
                : { finishReason: "other" as const }),
            });
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        // A broken transport must reject the reader so it can reconnect. An AI
        // error chunk would look like a successfully exhausted stream instead.
        if (!stopped) controller.error(error);
      }
    },
    cancel() {
      stopped = true;
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      "x-platform-run-id": run.id,
      "x-resumable-stream-id": run.id,
      "cache-control": "no-store",
    },
  });
}
