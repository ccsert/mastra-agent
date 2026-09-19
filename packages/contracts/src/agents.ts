import { Id, z } from "./common.ts";
import { KnowledgeSnapshot } from "./knowledge.ts";
import { Model } from "./models.ts";
import { SkillBinding, SkillSnapshot } from "./skills.ts";
import { Tool } from "./tools.ts";
export const ExecutionLimits = z
  .object({
    timeoutSeconds: z.number().int().min(30).max(7200).default(180),
    maxModelCalls: z.number().int().min(1).max(240).default(100),
    maxTokens: z.number().int().min(1000).max(20000000).default(400000),
    contextTokens: z.number().int().min(4000).max(2000000).default(32000),
    maxOutputTokens: z.number().int().min(512).max(32000).default(4096),
  })
  .strict()
  .openapi("ExecutionLimits");
export const DelegationConfig = z
  .object({
    enabled: z.boolean().default(false),
    maxCalls: z.number().int().min(1).max(8).default(3),
    maxParallel: z.number().int().min(1).max(4).default(2),
    maxSteps: z.number().int().min(1).max(20).default(3),
  })
  .strict()
  .openapi("DelegationConfig");
export const AgentInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    instructions: z.string().trim().min(1).max(16000),
    modelId: Id,
    toolIds: z.array(Id).max(20),
    knowledgeBaseIds: z.array(Id).max(5).default([]),
    skillBindings: z.array(SkillBinding).max(10).default([]),
    maxSteps: z.number().int().min(1).max(80).default(5),
    executionLimits: ExecutionLimits.optional(),
    workspaceEnabled: z.boolean().optional(),
    delegation: DelegationConfig.optional(),
    planningEnabled: z.boolean().optional(),
  })
  .strict()
  .openapi("AgentInput");
export const Agent = AgentInput.extend({
  id: Id,
  projectId: Id,
  draftRevision: z.number().int(),
  publishedReleaseId: Id.nullable(),
  publishedVersion: z.number().int().nullable(),
  createdAt: z.string(),
  hasUnpublishedChanges: z.boolean().optional(),
}).openapi("Agent");
export const AgentUpdate = AgentInput.extend({ baseRevision: z.number().int().positive() }).openapi(
  "AgentUpdate",
);
export const ReleaseSnapshot = z.object({
  agent: AgentInput,
  model: Model,
  tools: z.array(Tool),
  knowledgeBases: z.array(KnowledgeSnapshot).default([]),
  skills: z.array(SkillSnapshot).max(10).default([]),
  adapterVersion: z.literal("mastra-agent-v1"),
});
export type ReleaseSnapshot = z.infer<typeof ReleaseSnapshot>;
export const Release = z
  .object({
    id: Id,
    agentId: Id,
    projectId: Id,
    version: z.number().int(),
    digest: z.string(),
    snapshot: ReleaseSnapshot,
    sourceRevision: z.number().int().nullable().optional(),
    createdAt: z.string(),
  })
  .openapi("Release");
export type AgentInput = z.input<typeof AgentInput>;

export const AgentPreviewInput = z
  .object({ baseRevision: z.number().int().positive(), requestId: Id })
  .strict()
  .openapi("AgentPreviewInput");
export const AgentPreview = z
  .object({ conversationId: Id, releaseId: Id, draftRevision: z.number().int().positive() })
  .openapi("AgentPreview");
