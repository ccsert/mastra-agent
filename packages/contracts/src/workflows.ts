import { Release } from "./agents.ts";
import { Id, JsonSchema, RunStatus, z } from "./common.ts";
import { Model } from "./models.ts";
import { Tool } from "./tools.ts";
import {
  WorkflowAssetInput,
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowIssue,
} from "./workflow-definition.ts";
export const WorkflowAsset = WorkflowAssetInput.extend({
  id: Id,
  projectId: Id,
  revision: z.number().int(),
  publishedReleaseId: Id.nullable(),
  publishedVersion: z.number().int().nullable(),
  createdAt: z.string(),
}).openapi("WorkflowAsset");
export const WorkflowAssetUpdate = WorkflowAssetInput.extend({
  baseRevision: z.number().int().positive(),
}).openapi("WorkflowAssetUpdate");
export const WorkflowSnapshot = z
  .object({
    definition: WorkflowDefinition,
    tools: z.array(Tool),
    agents: z.array(Release),
    catalog: z.array(WorkflowCapability),
    adapterVersion: z.literal("mastra-workflow-v1"),
  })
  .openapi("WorkflowSnapshot");
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshot>;
export const WorkflowRelease = z
  .object({
    id: Id,
    workflowId: Id,
    projectId: Id,
    name: z.string(),
    version: z.number().int(),
    digest: z.string(),
    snapshot: WorkflowSnapshot,
    createdAt: z.string(),
  })
  .openapi("WorkflowRelease");
export const WorkflowRunInput = z
  .object({ releaseId: Id, input: JsonSchema, requestId: z.string().min(1).max(100) })
  .strict()
  .openapi("WorkflowRunInput");
export const WorkflowRun = z
  .object({
    id: Id,
    workflowId: Id,
    releaseId: Id,
    version: z.number().int(),
    name: z.string(),
    status: RunStatus,
    input: JsonSchema,
    output: JsonSchema.nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("WorkflowRun");
export const WorkflowNodeRun = z
  .object({
    nodeId: z.string(),
    label: z.string(),
    type: z.string(),
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "skipped"]),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    errorCode: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .openapi("WorkflowNodeRun");
export const WorkflowGenerationInput = z
  .object({
    baseRevision: z.number().int().positive(),
    modelId: Id,
    intent: z.string().trim().min(1).max(8000),
    capabilityIds: z.array(Id).max(200).optional(),
    requestId: z.string().min(1).max(100),
  })
  .strict()
  .openapi("WorkflowGenerationInput");
export const WorkflowCandidate = z
  .object({ definition: WorkflowDefinition, explanation: z.string().max(4000) })
  .strict()
  .openapi("WorkflowCandidate");
export const WorkflowGeneration = z
  .object({
    id: Id,
    workflowId: Id,
    baseRevision: z.number().int(),
    intent: z.string(),
    modelId: Id,
    status: RunStatus,
    candidate: WorkflowCandidate.nullable(),
    issues: z.array(WorkflowIssue),
    attempts: z.number().int(),
    acceptedRevision: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("WorkflowGeneration");
export const WorkflowRuntimeJob = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("execute"),
    id: Id,
    leaseToken: z.string(),
    deadline: z.number(),
    snapshot: WorkflowSnapshot,
    input: JsonSchema,
  }),
  z.object({
    kind: z.literal("generate"),
    id: Id,
    leaseToken: z.string(),
    deadline: z.number(),
    definition: WorkflowDefinition,
    catalog: z.array(WorkflowCapability),
    model: Model,
    apiKey: z.string(),
    intent: z.string(),
  }),
]);
export type WorkflowRuntimeJob = z.infer<typeof WorkflowRuntimeJob>;
export const WorkflowRuntimeFinish = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    candidate: WorkflowCandidate.optional(),
    attempts: z.number().int().min(1).max(3).optional(),
    errorCode: z.string().max(80).optional(),
  })
  .strict();
export const WorkflowNodeFinish = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed"]),
    output: z.unknown().optional(),
    errorCode: z.string().max(80).optional(),
  })
  .strict();
