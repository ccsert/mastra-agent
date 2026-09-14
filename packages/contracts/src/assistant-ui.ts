import { Id, z } from "./common.ts";
import { AssistantContext, AssistantPage } from "./platform-assistant.ts";

export const AssistantUiTargetId = z.enum([
  "agent.create",
  "agent.section",
  "agent.name",
  "agent.description",
  "agent.instructions",
  "skills.source",
  "tools.source",
  "capability.search",
  "capability.operations.search",
  "capability.operations.available",
]);
export const AssistantUiView = z
  .object({
    revision: Id,
    ready: z.boolean().default(true),
    page: AssistantPage,
    resourceId: Id.optional(),
    targets: z
      .array(
        z
          .object({
            id: AssistantUiTargetId,
            label: z.string().max(120),
            kind: z.enum(["click", "fill", "select"]),
            value: z.string().max(16000).optional(),
            options: z.array(z.string().max(80)).max(20).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .openapi("AssistantUiView");
// OpenAI-compatible providers require an object at the function schema root.
// The control plane validates the stricter operation union below after parsing.
export const AssistantUiToolInput = z
  .object({
    operation: z.enum(["inspect", "navigate", "act"]),
    viewRevision: Id.optional(),
    page: AssistantPage.optional(),
    resourceId: Id.optional(),
    target: AssistantUiTargetId.optional(),
    value: z.string().max(16000).optional(),
  })
  .strict();
export const AssistantUiOperation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect") }).strict(),
  AssistantContext.extend({ operation: z.literal("navigate"), viewRevision: Id }).strict(),
  z
    .object({
      operation: z.literal("act"),
      target: AssistantUiTargetId,
      value: z.string().max(16000).optional(),
      viewRevision: Id,
    })
    .strict(),
  z.object({ operation: z.literal("result"), actionId: Id }).strict(),
]);
export const AssistantUiReceipt = z
  .object({
    id: Id,
    status: z.enum(["pending", "executing", "succeeded", "failed"]),
    input: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("AssistantUiReceipt");
export const AssistantUiSyncInput = z
  .object({
    clientId: Id,
    enabled: z.boolean(),
    grant: z.boolean().default(false),
    view: AssistantUiView,
  })
  .strict()
  .openapi("AssistantUiSyncInput");
export const AssistantUiSync = z
  .object({ active: z.boolean(), action: z.union([AssistantUiReceipt, z.null()]) })
  .openapi("AssistantUiSync");
export const AssistantUiResultInput = z
  .object({
    clientId: Id,
    status: z.enum(["succeeded", "failed"]),
    message: z.string().max(1000),
    view: AssistantUiView,
  })
  .strict()
  .openapi("AssistantUiResultInput");
