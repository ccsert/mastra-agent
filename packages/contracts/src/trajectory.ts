import { z } from "./common.ts";

/** Runtime-generated timestamps carry an explicit offset; they are never inferred downstream. */
const instant = z.iso.datetime({ offset: true });

export const traceEventNames = {
  modelRequest: "data-model-request",
  modelResponse: "data-model-response",
  toolExecution: "data-tool-execution",
  runUsage: "data-run-usage",
  modelStep: "data-model-step",
  toolStart: "data-tool-start",
  subagent: "data-subagent",
  subagentEvent: "data-subagent-event",
  taskPlan: "data-task-plan",
} as const;

/**
 * Transport facts for one model request, measured at the provider fetch boundary.
 * This is protocol-agnostic: the body is observed, never parsed, and no request or
 * response header is copied. `firstByteMs` is the first response byte, not a
 * token-level first-token latency.
 */
export const ModelRequestTiming = z
  .object({
    requestIndex: z.number().int().positive(),
    httpStatus: z.number().int().nullable(),
    startedAt: instant,
    /** The moment response headers arrived. */
    responseAt: instant.nullable(),
    firstByteAt: instant.nullable(),
    completedAt: instant,
    durationMs: z.number().nonnegative(),
    firstByteMs: z.number().nonnegative().nullable(),
    responseBytes: z.number().nonnegative(),
    /** `incomplete` means the body was not drained; `failed` means no response arrived. */
    outcome: z.enum(["completed", "incomplete", "failed"]),
  })
  .openapi("ModelRequestTiming");
export type ModelRequestTiming = z.infer<typeof ModelRequestTiming>;

/** Which registered surface actually ran the tool. */
export const TraceToolSource = z.enum([
  "sum",
  "http_get",
  "mcp",
  "skill",
  "knowledge",
  "subagent",
  "planning",
  "workspace",
  "browser",
]);
export type TraceToolSource = z.infer<typeof TraceToolSource>;

/**
 * One tool execution, keyed by the model's own `toolCallId` so a call can be
 * joined to its request and result without relying on stream order.
 */
export const ToolExecution = z
  .object({
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    source: TraceToolSource,
    startedAt: instant,
    finishedAt: instant,
    durationMs: z.number().nonnegative(),
    outcome: z.enum(["succeeded", "failed"]),
    errorCode: z.string().max(200).optional(),
  })
  .openapi("ToolExecution");
export type ToolExecution = z.infer<typeof ToolExecution>;

/** Persist the execution boundary before a slow or cancelled tool can disappear. */
export const ToolExecutionStart = ToolExecution.pick({
  toolCallId: true,
  toolName: true,
  source: true,
  startedAt: true,
}).openapi("ToolExecutionStart");
export type ToolExecutionStart = z.infer<typeof ToolExecutionStart>;

/**
 * Provider-reported token usage. `null` means the provider did not report the
 * field; it is never estimated or defaulted to zero.
 */
export const TokenUsage = z.object({
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  totalTokens: z.number().nonnegative().nullable(),
  reasoningTokens: z.number().nonnegative().nullable(),
  cachedInputTokens: z.number().nonnegative().nullable(),
});

/** Mastra initializes an absent total to zero. Without either component this
 * is an unknown measurement, not a provider-reported zero-token completion. */
export function reportedTokenUsage(usage?: Partial<z.infer<typeof TokenUsage>>) {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens:
      usage?.totalTokens === 0 && usage.inputTokens == null && usage.outputTokens == null
        ? null
        : (usage?.totalTokens ?? null),
    reasoningTokens: usage?.reasoningTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
  };
}

/**
 * Run-level observation read from the model runtime after the stream settles.
 * `perStep` follows streaming order; it is aligned positionally, not joined by id.
 */
export const RunUsage = z
  .object({
    usage: TokenUsage,
    finishReason: z.string().max(200).nullable(),
    steps: z.number().int().nonnegative(),
    /** Runtime correlation keys, when the runtime exposes them. */
    traceId: z.string().max(200).nullable(),
    spanId: z.string().max(200).nullable(),
    perStep: z
      .array(
        z.object({
          stepIndex: z.number().int().nonnegative(),
          modelId: z.string().max(200).nullable(),
          finishReason: z.string().max(200).nullable(),
          usage: TokenUsage,
        }),
      )
      .max(256),
  })
  .openapi("RunUsage");
export type RunUsage = z.infer<typeof RunUsage>;

/** Emitted after each semantic generation; transport retries share its stepIndex. */
export const ModelStep = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    completedAt: instant,
    modelId: z.string().max(200).nullable(),
    finishReason: z.string().max(200).nullable(),
    usage: TokenUsage,
  })
  .openapi("ModelStep");
export type ModelStep = z.infer<typeof ModelStep>;

/** Agent-reported task states; completion is not inferred from list position or run status. */
export const PlanItem = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(240),
    status: z.enum(["pending", "in_progress", "completed", "blocked", "cancelled"]),
    detail: z.string().max(1000).optional(),
  })
  .strict()
  .openapi("PlanItem");
export const PlanUpdate = z
  .object({
    baseRevision: z.number().int().min(0).max(99),
    title: z.string().trim().min(1).max(120),
    explanation: z.string().trim().min(1).max(2000),
    items: z.array(PlanItem).min(1).max(20),
  })
  .strict()
  .openapi("PlanUpdate");
export type PlanUpdate = z.infer<typeof PlanUpdate>;
export const TaskPlan = PlanUpdate.omit({ baseRevision: true })
  .extend({
    revision: z.number().int().min(1).max(100),
    toolCallId: z.string().min(1).max(200),
    updatedAt: instant,
  })
  .openapi("TaskPlan");
export type TaskPlan = z.infer<typeof TaskPlan>;

/** Child executions are persisted in their parent run's append-only event log. */
export const SubagentLifecycle = z
  .object({
    id: z.string().uuid(),
    parentRunId: z.string().uuid(),
    parentToolCallId: z.string().min(1).max(200),
    name: z.string().min(1).max(80),
    task: z.string().min(1).max(12000),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "rejected"]),
    queuedAt: instant,
    startedAt: instant.nullable(),
    finishedAt: instant.nullable(),
    maxSteps: z.number().int().min(1).max(5),
    depth: z.literal(1),
    modelId: z.string(),
    allowedTools: z.array(z.string()).max(64),
    outputText: z.string().optional(),
    errorCode: z.string().max(200).optional(),
  })
  .openapi("SubagentLifecycle");
export type SubagentLifecycle = z.infer<typeof SubagentLifecycle>;
export const ExecutionObservation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data-task-plan"), data: TaskPlan }),
  z.object({ type: z.literal("data-model-response"), data: ModelRequestTiming }),
  z.object({ type: z.literal("data-tool-execution"), data: ToolExecution }),
  z.object({ type: z.literal("data-run-usage"), data: RunUsage }),
  z.object({ type: z.literal("data-model-step"), data: ModelStep }),
  z.object({ type: z.literal("data-tool-start"), data: ToolExecutionStart }),
]);
export const SubagentEvent = z
  .object({
    id: z.string().uuid(),
    parentToolCallId: z.string().min(1).max(200),
    occurredAt: instant,
    chunk: z.record(z.string(), z.unknown()),
    observation: ExecutionObservation.optional(),
  })
  .openapi("SubagentEvent");

/** Validated observations are exposed alongside the lossless protocol chunk. */
export const TraceObservation = z
  .discriminatedUnion("type", [
    ...ExecutionObservation.options,
    z.object({ type: z.literal("data-subagent"), data: SubagentLifecycle }),
    z.object({ type: z.literal("data-subagent-event"), data: SubagentEvent }),
  ])
  .openapi("TraceObservation");
