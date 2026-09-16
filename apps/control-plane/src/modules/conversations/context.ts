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
    `SELECT COALESCE((rel.snapshot->'agent'->'executionLimits'->>'contextTokens')::int, 32000) AS window,
       COALESCE(rel.snapshot->'agent'->>'instructions','') AS instructions,
       COALESCE(rel.snapshot->'tools','[]'::jsonb) AS tools
     FROM conversations c JOIN releases rel ON rel.id=c.release_id WHERE c.id=$1`,
    [id],
  );
  // Occupancy projection for the NEXT request: the summary plus uncovered
  // messages, exactly as the runtime reassembles them after compaction.
  const history = await modelHistory(tx, id);
  // The system prompt and tool definitions travel with every request; take
  // them from the agent's published snapshot rather than the last request.
  const systemChars = String(limits?.instructions ?? "").length;
  const toolsChars = JSON.stringify(limits?.tools ?? []).length;
  let messageChars = 0;
  for (const message of history)
    for (const part of message.parts) {
      messageChars +=
        typeof part.text === "string" ? part.text.length : JSON.stringify(part ?? null).length;
    }
  const totalChars = Math.max(1, systemChars + toolsChars + messageChars);
  // Mixed CJK/latin heuristic: ~3.5 characters per token. The ~ prefix marks
  // every displayed number as an estimate.
  const tokens = Math.ceil(totalChars / 3.5);
  const share = (chars: number) => Math.round((chars / totalChars) * tokens);
  return ConversationContext.parse({
    totalMessages: Number(row.total),
    coveredMessages: Number(row.covered),
    summary: row.summary ?? null,
    runId: row.run_id ?? null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    contextTokens: tokens,
    contextWindow: Number(limits?.window ?? 32000),
    contextBreakdown: {
      system: share(systemChars),
      tools: share(toolsChars),
      messages: share(messageChars),
    },
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
