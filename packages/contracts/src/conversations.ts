import { ReleaseSnapshot } from "./agents.ts";
import { Id, RunStatus, z } from "./common.ts";
import { McpErrorCode } from "./mcp.ts";
import { SkillErrorCode } from "./skills.ts";
export const ConversationInput = z
  .object({ agentId: Id, title: z.string().trim().min(1).max(100).default("新会话") })
  .strict()
  .openapi("ConversationInput");
export const Conversation = z
  .object({
    id: Id,
    agentId: Id,
    projectId: Id,
    releaseId: Id,
    releaseVersion: z.number().int(),
    title: z.string(),
    createdAt: z.string(),
  })
  .openapi("Conversation");
export const Message = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("Message");
export const RunInput = z
  .object({
    conversationId: Id,
    input: z.string().trim().min(1).max(16000),
    requestId: z.string().min(1).max(100),
  })
  .strict()
  .openapi("RunInput");
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
  })
  .openapi("Run");
export const RunEvent = z
  .object({
    seq: z.number().int(),
    chunk: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("RunEvent");
export const ExecutionJob = z.object({
  runId: Id,
  leaseToken: z.string(),
  snapshot: ReleaseSnapshot,
  messages: z.array(Message),
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
      ])
      .optional(),
  })
  .strict();
