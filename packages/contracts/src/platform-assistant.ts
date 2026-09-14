import { Permission } from "./access.ts";
import { Id, z } from "./common.ts";
export const AssistantPage = z.enum([
  "overview",
  "agents",
  "skills",
  "chat",
  "knowledge",
  "workflows",
  "models",
  "tools",
  "mcp",
  "runs",
  "applications",
  "runtimes",
  "settings",
  "team",
]);
export const AssistantContext = z
  .object({ page: AssistantPage.default("overview"), resourceId: Id.optional() })
  .strict();
export const AssistantActionInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    operation: z.string().min(1).max(80),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export const AssistantProposalInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    reason: z.string().max(2000),
    actions: z.array(AssistantActionInput).min(1).max(8),
  })
  .strict();
export const AssistantToolRequest = z
  .object({
    leaseToken: z.string(),
    toolCallId: z.string().min(1).max(200),
    tool: z.enum(["catalog", "read", "skill", "propose", "navigate", "ui", "app"]),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export const AssistantAction = AssistantActionInput.extend({
  label: z.string(),
  risk: z.enum(["draft", "publish", "access"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "unknown"]),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
}).openapi("AssistantAction");
export const AssistantProposal = z
  .object({
    id: Id,
    conversationId: Id,
    title: z.string(),
    reason: z.string(),
    status: z.enum(["pending", "applying", "succeeded", "failed", "dismissed"]),
    actions: z.array(AssistantAction),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("AssistantProposal");
export const AssistantSession = z
  .object({ id: Id, title: z.string(), createdAt: z.string(), context: AssistantContext })
  .openapi("AssistantSession");
export const AssistantConfiguration = z.object({ modelId: Id, modelName: z.string() }).nullable();
export const AssistantBootstrap = z
  .object({
    configuration: AssistantConfiguration,
    canConfigure: z.boolean(),
    skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
    operations: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        group: z.string(),
        mode: z.enum(["read", "write"]),
        risk: z.enum(["draft", "publish", "access"]),
      }),
    ),
    sessions: z.array(AssistantSession),
  })
  .openapi("AssistantBootstrap");
export const AssistantStartInput = z
  .object({
    requestId: Id,
    context: AssistantContext,
    message: z.string().trim().min(1).max(16000).optional(),
  })
  .strict()
  .openapi("AssistantStartInput");
export const AssistantSettingsInput = z
  .object({ modelId: Id })
  .strict()
  .openapi("AssistantSettingsInput");
export const AssistantSystemContext = z.object({
  version: z.literal(1),
  page: AssistantPage,
  resourceId: Id.optional(),
});

const CapabilityUsage = z.object({
  count: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
});
export const AssistantCapabilityOperation = z
  .object({
    id: z.string(),
    label: z.string(),
    group: z.string(),
    mode: z.enum(["read", "write"]),
    risk: z.enum(["draft", "publish", "access"]),
    permission: Permission,
    tenantAdmin: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.string().nullable(),
  })
  .openapi("AssistantCapabilityOperation");
export const AssistantOperationDetail = AssistantCapabilityOperation.extend({
  inputSchema: z.record(z.string(), z.unknown()),
}).openapi("AssistantOperationDetail");
export const AssistantCapabilities = z
  .object({
    version: z.literal(1),
    conversationId: Id.nullable(),
    permissions: z.array(Permission),
    skills: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        instructions: z.string(),
        version: z.number().int(),
        digest: z.string(),
        source: z.literal("system"),
        readOnly: z.literal(true),
        bindable: z.literal(false),
        usage: CapabilityUsage,
      }),
    ),
    tools: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        summary: z.string(),
        version: z.number().int(),
        digest: z.string(),
        source: z.literal("system"),
        readOnly: z.literal(true),
        bindable: z.literal(false),
        inputSchema: z.record(z.string(), z.unknown()),
        available: z.boolean(),
        unavailableReason: z.string().nullable(),
        usage: CapabilityUsage,
      }),
    ),
    operations: z.array(AssistantCapabilityOperation),
  })
  .openapi("AssistantCapabilities");
