import { Id, z } from "./common.ts";
import { TaskStateInput } from "./long-tasks.ts";
import { TaskFeedback } from "./task-feedback.ts";
import { SubagentLifecycle, ToolApprovalObservation } from "./trajectory.ts";

export const SkillActivation = z.object({
  versionId: Id,
  name: z.string(),
  version: z.number().int(),
  source: z.enum(["selected", "model"]),
  loadedAt: z.string(),
  toolCallId: z.string().nullable(),
});
export const RunArtifact = z
  .object({
    id: z.string().regex(/^(\d+-(json|csv|txt)|file-[a-f0-9-]{36})$/),
    name: z.string(),
    mediaType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    toolCallId: z.string(),
    subagentId: Id.nullable(),
    createdAt: z.string(),
    source: z.enum(["tool-result", "script-stdout", "workspace"]),
  })
  .openapi("RunArtifact");
export const RunWorkspace = z
  .object({
    feedback: z.array(TaskFeedback).optional(),
    execution: z
      .object({
        maxSteps: z.number(),
        maxModelCalls: z.number(),
        modelCalls: z.number(),
        reservedTokens: z.number(),
        maxTokens: z.number(),
        recoveries: z.number(),
        deadline: z.string(),
      })
      .optional(),
    taskState: TaskStateInput.extend({ revision: z.number(), runId: Id }).optional(),
    /** Human confirmation gates for write tools, newest state per call. */
    approvals: z.array(ToolApprovalObservation).default([]),
    skills: z.array(SkillActivation.extend({ subagentId: Id.nullable() })),
    artifacts: z.array(RunArtifact),
    subagents: z.array(
      SubagentLifecycle.extend({
        toolCount: z.number().int(),
        completedTools: z.number().int(),
        activity: z.string(),
        outputText: z.string(),
      }),
    ),
  })
  .openapi("RunWorkspace");
