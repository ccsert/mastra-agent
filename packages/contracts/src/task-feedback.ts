import { Id, z } from "./common.ts";

export const TaskFeedbackInput = z
  .object({
    requestId: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(2000),
  })
  .strict()
  .openapi("TaskFeedbackInput");
export const TaskFeedback = z
  .object({
    id: Id,
    runId: Id,
    text: z.string(),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  })
  .openapi("TaskFeedback");
export type TaskFeedback = z.infer<typeof TaskFeedback>;
