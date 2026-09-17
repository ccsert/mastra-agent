import { ReleaseSnapshot } from "./agents.ts";
import { Id, RunStatus, z } from "./common.ts";
import { AgentLimitError, TaskStateInput } from "./long-tasks.ts";
import { McpErrorCode } from "./mcp.ts";
import { AssistantSystemContext } from "./platform-assistant.ts";
import { SkillErrorCode } from "./skills.ts";
import { TraceObservation } from "./trajectory.ts";
export const ConversationInput = z
  .object({ agentId: Id, title: z.string().trim().min(1).max(100).default("新会话") })
  .strict()
  .openapi("ConversationInput");
/**
 * What happens when a run wants to call a write tool. `readonly` refuses every
 * gated call without prompting anyone; `ask` pauses for a person per call;
 * `auto` runs gated tools without asking. The choice belongs to the
 * conversation and applies from its next run.
 */
export const ApprovalPolicy = z.enum(["readonly", "ask", "auto"]).openapi("ApprovalPolicy");
export const Conversation = z
  .object({
    id: Id,
    agentId: Id,
    projectId: Id,
    releaseId: Id,
    releaseVersion: z.number().int(),
    title: z.string(),
    createdAt: z.string(),
    pinnedAt: z.string().nullable().default(null),
    parentConversationId: Id.nullable().default(null),
    parentMessageId: z.string().nullable().default(null),
    approvalPolicy: ApprovalPolicy.default("ask"),
  })
  .openapi("Conversation");
export const ConversationUpdateInput = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    pinned: z.boolean().optional(),
    approvalPolicy: ApprovalPolicy.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined || input.pinned !== undefined || input.approvalPolicy !== undefined,
    { message: "至少提供 title、pinned 或 approvalPolicy 之一" },
  )
  .openapi("ConversationUpdate");
export const DeriveConversationInput = z
  .object({
    upToMessageId: z.string().min(1).max(200),
    requestId: z.string().min(8).max(100),
  })
  .strict()
  .openapi("ConversationDerive");
export const SelectedSkill = z.object({
  versionId: Id,
  name: z.string(),
  version: z.number().int(),
});
export const SkillSelection = z.array(Id).max(10).default([]);
export const EditConversationInput = z
  .object({
    messageId: z.string().min(1).max(200),
    input: z.string().trim().min(1).max(16000),
    requestId: z.string().min(1).max(100),
  })
  .strict()
  .openapi("EditConversationInput");
export const ConversationCapabilities = z
  .object({
    skills: z.array(SelectedSkill.extend({ description: z.string(), enabled: z.boolean() })),
  })
  .openapi("ConversationCapabilities");
export const Message = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.record(z.string(), z.unknown())),
    metadata: z
      .object({
        runId: Id,
        originConversationId: Id.optional(),
        selectedSkills: z.array(SelectedSkill).default([]),
        runStatus: RunStatus.optional(),
        errorCode: z.string().nullable().optional(),
      })
      .optional(),
  })
  .openapi("Message");
export const RunInput = z
  .object({
    conversationId: Id,
    input: z.string().trim().min(1).max(16000),
    requestId: z.string().min(1).max(100),
    skillVersionIds: SkillSelection,
  })
  .strict()
  .openapi("RunInput");
export const ConversationSession = z
  .object({
    messages: z.array(Message),
    resumeRun: z.object({ id: Id, status: RunStatus }).nullable(),
  })
  .openapi("ConversationSession");
export const Run = z
  .object({
    id: Id,
    conversationId: Id,
    releaseId: Id,
    releaseVersion: z.number().int(),
    agentName: z.string(),
    status: RunStatus,
    runtimeId: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    outputText: z.string().nullable(),
    inputText: z.string().nullable().default(null),
    agentInstructions: z.string().nullable().default(null),
    registeredTools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
        }),
      )
      .default([]),
    selectedSkills: z.array(SelectedSkill).default([]),
  })
  .openapi("Run");
export const RunEvent = z
  .object({
    seq: z.number().int(),
    chunk: z.record(z.string(), z.unknown()),
    /** When the control plane received the event. */
    createdAt: z.string(),
    /**
     * When the Runtime produced the event. Falls back to `createdAt` for events
     * persisted before runtimes reported their own clock.
     */
    occurredAt: z.string(),
    /** Which clock `occurredAt` came from; a runtime time is never fabricated for old runs. */
    timeSource: z.enum(["runtime", "control-plane"]),
    observation: TraceObservation.optional(),
  })
  .openapi("RunEvent");
export const ConversationRunSummary = Conversation.extend({
  agentName: z.string(),
  runCount: z.number().int(),
  latestRunId: Id,
  latestStatus: RunStatus,
  lastRunAt: z.string(),
}).openapi("ConversationRunSummary");
export const TraceTurn = z
  .object({
    number: z.number().int().positive(),
    run: Run,
    events: z.array(RunEvent),
    hasMoreEvents: z.boolean(),
    /** A per-turn read boundary. Events appended later belong to the next refresh. */
    checkpoint: z
      .object({
        eventCount: z.number().int().nonnegative(),
        lastSeq: z.number().int().min(-1),
        capturedAt: z.string(),
      })
      .optional(),
    /** Exact stored messages linked by runId; never matched by similar text. */
    messages: z.array(Message).optional(),
  })
  .openapi("TraceTurn");
export const ConversationTrace = z
  .object({
    initial: z.object({ run: Run, request: z.object(RunEvent.shape).nullable() }).nullable(),
    turns: z.array(TraceTurn),
    totalTurns: z.number().int().nonnegative(),
    nextBefore: z.number().int().positive().nullable(),
  })
  .openapi("ConversationTrace");
export const TraceQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export const ConversationStats = z
  .object({
    /** Completed (or in-flight) user turns with a settled run record. */
    turns: z.number().int().nonnegative(),
    /** Total model round trips across those turns. */
    steps: z.number().int().nonnegative(),
    /** Sum of measured model-transport durations; null when none was recorded. */
    modelMs: z.number().int().nonnegative().nullable().default(null),
    /** Sum of provider-reported output tokens; null when never reported. */
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    /** Sum of provider-reported input tokens; null when never reported. */
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    /** Sum of provider-reported cached input tokens; null when never reported. */
    cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
  })
  .openapi("ConversationStats");
export const ConversationContext = z
  .object({
    totalMessages: z.number().int().nonnegative(),
    coveredMessages: z.number().int().nonnegative(),
    summary: z.string().nullable(),
    runId: Id.nullable(),
    createdAt: z.string().nullable(),
    /** Largest measured model input for this conversation; null when never run. */
    contextTokens: z.number().int().nullable().default(null),
    /** The agent's model context window; null when unknown. */
    contextWindow: z.number().int().nullable().default(null),
    /** Rough composition of the newest assembled request, estimated from character shares. */
    contextBreakdown: z
      .object({
        system: z.number().int().nonnegative(),
        tools: z.number().int().nonnegative(),
        messages: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
  })
  .openapi("ConversationContext");
export const ExecutionJob = z.object({
  /** The conversation's write-tool mode at claim time. Mid-run changes wait
   * for the next run; the current one keeps the policy it started with. */
  approvalPolicy: ApprovalPolicy.default("ask"),
  compaction: z
    .object({
      transcript: z.string(),
      focus: z.string(),
      /** Provider-native messages and tools of the newest recorded request,
       * replayed verbatim so the summarization call continues that exact
       * prefix and reuses the provider's warm cache instead of paying full
       * price for the whole conversation. Absent when no usable record
       * exists, or when the retry must shrink rather than replay. */
      prefix: z
        .object({
          model: z.string(),
          messages: z.array(z.record(z.string(), z.unknown())),
          tools: z.array(z.record(z.string(), z.unknown())).optional(),
          toolChoice: z.unknown().optional(),
          temperature: z.number().optional(),
          maxTokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  systemAssistant: AssistantSystemContext.optional(),
  runId: Id,
  conversationId: Id.optional(),
  nextEventSeq: z.number().int().nonnegative().default(0),
  recoveryCount: z.number().int().nonnegative().default(0),
  nextStepIndex: z.number().int().nonnegative().default(0),
  previousMessage: Message.optional(),
  taskState: TaskStateInput.extend({ revision: z.number().int(), runId: Id }).optional(),
  leaseToken: z.string(),
  snapshot: ReleaseSnapshot,
  messages: z.array(Message),
  skillVersionIds: SkillSelection,
  credentials: z.object({
    modelApiKey: z.string(),
    toolTokens: z.record(z.string(), z.string()),
    knowledgeModelKeys: z.record(z.string(), z.string()).default({}),
  }),
  deadline: z.number(),
});
export type ExecutionJob = z.infer<typeof ExecutionJob>;
export const RuntimeEventInput = z
  .object({
    leaseToken: z.string(),
    seq: z.number().int().nonnegative(),
    /** The Runtime's own clock for this event. Omitted by runtimes predating it. */
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    chunk: z.record(z.string(), z.unknown()),
  })
  .strict();
export const RuntimeFinishInput = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    message: Message.optional(),
    outputText: z.string().max(200000).optional(),
    errorCode: z
      .union([
        z.enum(["MODEL_ERROR", "RUNTIME_ERROR", "TIMEOUT", "CANCELLED"]),
        McpErrorCode,
        SkillErrorCode,
        AgentLimitError,
      ])
      .optional(),
  })
  .strict();
