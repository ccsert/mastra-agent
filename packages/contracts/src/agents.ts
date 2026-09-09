import { Id, z } from "./common.ts";
import { KnowledgeSnapshot } from "./knowledge.ts";
import { Model } from "./models.ts";
import { SkillBinding, SkillSnapshot } from "./skills.ts";
import { Tool } from "./tools.ts";
export const AgentInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    instructions: z.string().trim().min(1).max(16000),
    modelId: Id,
    toolIds: z.array(Id).max(20),
    knowledgeBaseIds: z.array(Id).max(5).default([]),
    skillBindings: z.array(SkillBinding).max(10).default([]),
    maxSteps: z.number().int().min(1).max(10).default(5),
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
    createdAt: z.string(),
  })
  .openapi("Release");
export type AgentInput = z.input<typeof AgentInput>;
