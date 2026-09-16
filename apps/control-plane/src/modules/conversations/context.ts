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
  // Current occupancy: the newest regular run's last measured model input —
  // compaction runs measure the summarizer, not the conversation.
  const [usage] = await tx.query(
    `SELECT CASE WHEN jsonb_typeof(e.chunk)='object'
       THEN (e.chunk->'data'->'usage'->>'inputTokens')::int END AS tokens
     FROM run_events e JOIN runs r ON r.id=e.run_id
     WHERE r.conversation_id=$1 AND COALESCE(r.context_action,'')<>'compact'
       AND e.chunk->>'type'='data-model-step'
     ORDER BY r.created_at DESC,r.id DESC,e.seq DESC LIMIT 1`,
    [id],
  );
  // Composition estimate from the newest assembled request, so the breakdown
  // reflects what the model actually received (system prompt, tool
  // definitions, conversation messages including any summary).
  const [lastRequest] = await tx.query(
    `SELECT e.chunk->'data'->'request' AS request
     FROM run_events e JOIN runs r ON r.id=e.run_id
     WHERE r.conversation_id=$1 AND COALESCE(r.context_action,'')<>'compact'
       AND e.chunk->>'type'='data-model-request'
     ORDER BY r.created_at DESC,r.id DESC,e.seq DESC LIMIT 1`,
    [id],
  );
  let breakdown: { system: number; tools: number; messages: number } | null = null;
  const request = (lastRequest?.request ?? null) as
    | { messages?: { role?: string; content?: unknown }[]; tools?: unknown[] }
    | undefined;
  if (request && Array.isArray(request.messages)) {
    let systemChars = 0,
      toolChars = 0,
      messageChars = 0;
    for (const message of request.messages) {
      const role = String(message.role ?? "user");
      const size =
        typeof message.content === "string"
          ? message.content.length
          : JSON.stringify(message.content ?? "").length;
      if (role === "system" || role === "developer") systemChars += size;
      else messageChars += size;
    }
    toolChars = JSON.stringify(request.tools ?? []).length;
    const total = Math.max(1, systemChars + toolChars + messageChars);
    const measured = Number(usage?.tokens ?? 0) || Math.round(total / 3);
    const share = (chars: number) => Math.round((chars / total) * measured);
    breakdown = {
      system: share(systemChars),
      tools: share(toolChars),
      messages: share(messageChars),
    };
  }
  return ConversationContext.parse({
    totalMessages: Number(row.total),
    coveredMessages: Number(row.covered),
    summary: row.summary ?? null,
    runId: row.run_id ?? null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    contextTokens: usage?.tokens ?? null,
    contextWindow: Number(limits?.window ?? 32000),
    contextBreakdown: breakdown,
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
