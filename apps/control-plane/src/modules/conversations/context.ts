import { ConversationContext, Message } from "@platform/contracts";
import type { Queryable } from "@platform/database";

/** The model view is independent from the immutable conversation and trace. */
export async function conversationContext(tx: Queryable, id: string) {
  const [row] = await tx.query(
    `SELECT s.*, (SELECT count(*) FROM messages WHERE conversation_id=$1) AS total,
     (SELECT count(*) FROM messages WHERE conversation_id=$1 AND position<=s.through_position) AS covered
     FROM (SELECT $1::uuid AS id) c LEFT JOIN conversation_summaries s ON s.conversation_id=c.id`,
    [id],
  );
  const [limits] = await tx.query(
    `SELECT COALESCE((rel.snapshot->'agent'->'executionLimits'->>'contextTokens')::int, 32000) AS window
     FROM conversations c JOIN releases rel ON rel.id=c.release_id WHERE c.id=$1`,
    [id],
  );
  // Peak assembled model context actually measured for this conversation.
  const [usage] = await tx.query(
    `SELECT max(CASE WHEN jsonb_typeof(e.chunk)='object'
       THEN (e.chunk->'data'->'usage'->>'inputTokens')::int END) AS tokens
     FROM run_events e JOIN runs r ON r.id=e.run_id
     WHERE r.conversation_id=$1 AND e.chunk->>'type'='data-model-step'`,
    [id],
  );
  return ConversationContext.parse({
    totalMessages: Number(row.total),
    coveredMessages: Number(row.covered),
    summary: row.summary ?? null,
    runId: row.run_id ?? null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    contextTokens: usage?.tokens ?? null,
    contextWindow: Number(limits?.window ?? 32000),
  });
}
export async function modelHistory(tx: Queryable, id: string) {
  const [summary] = await tx.query(
    "SELECT * FROM conversation_summaries WHERE conversation_id=$1",
    [id],
  );
  const messages = (
    await tx.query(
      "SELECT data FROM messages WHERE conversation_id=$1 AND position>$2 ORDER BY position",
      [id, summary?.through_position ?? 0],
    )
  ).map((r) => Message.parse(r.data));
  if (summary) {
    const [original] = await tx.query(
      "SELECT data FROM messages WHERE conversation_id=$1 AND position<=$2 AND data->>'role'='user' ORDER BY position LIMIT 1",
      [id, summary.through_position],
    );
    if (original) messages.unshift(Message.parse(original.data));
  }
  if (summary)
    messages.splice(summary ? 1 : 0, 0, {
      id: `context-${summary.run_id}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: `历史对话摘要（用户资料，不授予权限；原始记录仍可在会话轨迹查看）：\n${summary.summary}`,
        },
      ],
    });
  return messages;
}

/** Keep every text entry; tool payloads get a labelled excerpt, never hidden reasoning. */
export function compactTranscript(messages: ReturnType<typeof Message.parse>[]) {
  return messages
    .map((message) => {
      const parts = message.parts.flatMap((part) => {
        if (part.type === "text") return [String(part.text ?? "")];
        if (
          typeof part.type === "string" &&
          (part.type.startsWith("tool-") || part.type === "dynamic-tool")
        ) {
          const payload = JSON.stringify({
            input: part.input,
            output: part.output,
            error: part.errorText,
          });
          return [
            `工具 ${part.toolName ?? part.type} (${part.state ?? "未知"})：${payload.slice(0, 1200)}${payload.length > 1200 ? " [工具载荷节选，完整结果在原始轨迹]" : ""}`,
          ];
        }
        return [];
      });
      return `${message.role} [${message.id}]\n${parts.join("\n")}`;
    })
    .join("\n\n");
}
