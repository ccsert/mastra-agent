import { Credential, Id, JsonSchema, z } from "./common.ts";
import { McpDescriptor } from "./mcp.ts";
export const ToolInput = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
    description: z.string().min(1).max(1000),
    kind: z.enum(["sum", "http_get"]),
    url: z.string().max(500).default(""),
    bearerToken: Credential.default(""),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
  })
  .strict()
  .openapi("ToolInput");
export const Tool = ToolInput.omit({ bearerToken: true })
  .extend({
    kind: z.enum(["sum", "http_get", "mcp"]),
    mcp: z
      .object({ serverId: Id, descriptor: McpDescriptor, contractDigest: z.string() })
      .optional(),
    id: Id,
    projectId: Id,
    hasCredential: z.boolean(),
    createdAt: z.string(),
    version: z.literal(1),
  })
  .openapi("Tool");
export type ToolInput = z.infer<typeof ToolInput>;
