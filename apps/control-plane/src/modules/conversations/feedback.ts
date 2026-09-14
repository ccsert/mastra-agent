import { randomUUID } from "node:crypto";
import { TaskFeedback, TaskFeedbackInput, type z } from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { ApiError } from "../../infrastructure/errors.ts";

export function feedbackDto(row: Row) {
  return TaskFeedback.parse({
    id: row.id,
    runId: row.run_id,
    text: row.text,
    createdAt: new Date(String(row.created_at)).toISOString(),
    readAt: row.read_at ? new Date(String(row.read_at)).toISOString() : null,
  });
}

/** The caller authorizes and locks the owning run before entering this operation. */
export async function saveFeedback(
  tx: Queryable,
  run: Row,
  input: z.infer<typeof TaskFeedbackInput>,
) {
  const checked = TaskFeedbackInput.parse(input);
  const [prior] = await tx.query("SELECT * FROM task_feedback WHERE run_id=$1 AND request_id=$2", [
    run.id,
    checked.requestId,
  ]);
  if (prior) {
    if (prior.text !== checked.text)
      throw new ApiError(409, "EVENT_CONFLICT", "同一提交标识的补充要求不一致");
    return feedbackDto(prior);
  }
  if (
    !["queued", "running"].includes(String(run.status)) ||
    run.cancel_requested ||
    new Date(String(run.deadline)).getTime() <= Date.now()
  )
    throw new ApiError(409, "RUN_NOT_ACTIVE", "本轮已经结束，请作为新消息发送");
  const [count] = await tx.query("SELECT count(*) AS total FROM task_feedback WHERE run_id=$1", [
    run.id,
  ]);
  if (Number(count.total) >= 8)
    throw new ApiError(409, "FEEDBACK_LIMIT", "本轮最多补充 8 次要求，请等待完成后发送新消息");
  const [row] = await tx.query(
    "INSERT INTO task_feedback(id,run_id,request_id,text) VALUES($1,$2,$3,$4) RETURNING *",
    [randomUUID(), run.id, checked.requestId, checked.text],
  );
  return feedbackDto(row);
}

export async function readFeedback(tx: Queryable, conversationId: unknown) {
  const rows = await tx.query(
    "SELECT f.* FROM task_feedback f JOIN runs r ON r.id=f.run_id WHERE r.conversation_id=$1 ORDER BY f.position DESC LIMIT 8",
    [conversationId],
  );
  return rows.reverse().map(feedbackDto);
}
