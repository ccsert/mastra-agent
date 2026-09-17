import { Credential, Id, JsonSchema, z } from "./common.ts";
export const McpDescriptor = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().max(200).optional(),
    description: z.string().max(4000).default(""),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema.optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    execution: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("McpDescriptor");
export const McpServerInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.url().max(500),
    bearerToken: Credential.default(""),
  })
  .strict()
  .openapi("McpServerInput");
export const McpServer = McpServerInput.omit({ bearerToken: true })
  .extend({
    id: Id,
    projectId: Id,
    enabled: z.boolean(),
    hasCredential: z.boolean(),
    transport: z.literal("streamable-http"),
    createdAt: z.string(),
  })
  .openapi("McpServer");
export const McpServerUpdate = z
  .object({
    enabled: z.boolean().optional(),
    bearerToken: Credential.optional(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.bearerToken !== undefined)
  .openapi("McpServerUpdate");
export const McpDiscovery = z
  .object({
    id: Id,
    serverId: Id,
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    tools: z.array(McpDescriptor).max(100),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("McpDiscovery");
/**
 * Importing a remote MCP capability. Read-only tools need an explicit
 * confirmation; a tool the service did not declare read-only can still be
 * imported, but only with `acceptWriteConfirmations=true`, which binds the
 * operator to the platform's per-call human confirmation.
 */
export const McpImport = z
  .object({
    discoveryId: Id,
    remoteName: z.string().min(1).max(128),
    name: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
    confirmedReadOnly: z.literal(true).optional(),
    acceptWriteConfirmations: z.boolean().optional(),
  })
  .strict()
  .openapi("McpImport");
export const McpJob = z.object({
  id: Id,
  serverId: Id,
  leaseToken: z.string(),
  deadline: z.number(),
  url: z.string(),
  bearerToken: z.string(),
});
export type McpJob = z.infer<typeof McpJob>;
export const McpFinish = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed"]),
    tools: z.array(McpDescriptor).max(100).optional(),
    errorCode: z
      .enum(["MCP_CONNECTION_FAILED", "MCP_DISCOVERY_INVALID", "MCP_LIMIT", "TIMEOUT"])
      .optional(),
  })
  .strict();
export const McpErrorCode = z.enum([
  "MCP_CONNECTION_FAILED",
  "MCP_TIMEOUT",
  "MCP_CONTRACT_CHANGED",
  "MCP_INPUT_INVALID",
  "MCP_RESULT_INVALID",
  "MCP_CONTENT_UNSUPPORTED",
  "MCP_TOOL_ERROR",
  "MCP_SCHEMA_UNSUPPORTED",
  "MCP_AUTH_DENIED",
  "MCP_LIMIT",
]);
