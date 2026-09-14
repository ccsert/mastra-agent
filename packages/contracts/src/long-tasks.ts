import { z } from "./common.ts";

export const TaskStateInput = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    objective: z.string().trim().min(1).max(4000),
    constraints: z.array(z.string().max(1000)).max(30),
    progress: z.string().max(8000),
    nextSteps: z.array(z.string().max(1000)).max(20),
    evidence: z
      .array(z.object({ reference: z.string().max(500), finding: z.string().max(2000) }))
      .max(40),
    status: z.enum(["in_progress", "needs_review", "completed"]),
  })
  .strict();
export const AgentLimitError = z.enum([
  "MODEL_CALL_LIMIT",
  "TOKEN_BUDGET",
  "BUDGET_UNAVAILABLE",
  "STEP_LIMIT",
  "TOOL_OUTCOME_UNKNOWN",
  "WORKSPACE_UNAVAILABLE",
  "WORKSPACE_LIMIT",
  "WORKSPACE_COMMAND_FAILED",
]);
export const RuntimeTaskRequest = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("feedback") }),
    z.object({ operation: z.literal("feedback-read"), ids: z.array(z.string().uuid()).max(8) }),
    z.object({
      operation: z.literal("artifact"),
      name: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^/\\\r\n]+$/),
      mediaType: z.enum([
        "text/html",
        "image/png",
        "application/zip",
        "application/json",
        "text/plain",
      ]),
      contentBase64: z
        .string()
        .max(7 * 1024 * 1024)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      toolCallId: z.string().min(1).max(200),
    }),
    z.object({
      operation: z.literal("reserve"),
      requestId: z.string().min(1).max(100),
      estimatedTokens: z.number().int().min(0).max(10000000),
    }),
    z.object({
      operation: z.literal("settle"),
      requestId: z.string().min(1).max(100),
      actualTokens: z.number().int().min(0).max(10000000),
    }),
    z.object({
      operation: z.literal("load"),
      workflowName: z.enum(["durable-agentic-loop", "durable-agentic-execution"]),
    }),
    z.object({
      operation: z.literal("save"),
      workflowName: z.enum(["durable-agentic-loop", "durable-agentic-execution"]),
      snapshot: z.record(z.string(), z.unknown()),
    }),
    z.object({ operation: z.literal("history"), runId: z.string().uuid().optional() }),
    z.object({ operation: z.literal("list") }),
    z.object({
      operation: z.literal("delete"),
      workflowName: z.enum(["durable-agentic-loop", "durable-agentic-execution"]),
    }),
    z.object({
      operation: z.literal("tool-start"),
      callId: z.string().min(1).max(200),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.object({
      operation: z.literal("tool-finish"),
      callId: z.string().min(1).max(200),
      output: z.unknown(),
      errorCode: z.string().max(100).optional(),
    }),
    z.object({ operation: z.literal("state"), state: TaskStateInput }),
  ])
  .and(z.object({ leaseToken: z.string() }));
