import { Credential, Id, JsonSchema, z } from "./common.ts";
import { McpDescriptor } from "./mcp.ts";
/**
 * The two kinds an operator authors by hand. `mcp` is deliberately absent: an
 * imported MCP tool is a pinned projection of a remote descriptor, produced by
 * the import flow rather than typed in here.
 */
export const AuthoredToolKind = z.enum(["sum", "http_get"]).openapi("AuthoredToolKind");
export const ToolInput = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
    description: z.string().min(1).max(1000),
    kind: AuthoredToolKind,
    url: z.string().max(500).default(""),
    bearerToken: Credential.default(""),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    /** Declares that calling this tool can change business data or trigger
     * external effects, so a run pauses for human confirmation first. */
    writes: z.boolean().default(false),
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
/**
 * Editing a tool changes what future publishes use; releases embed their own
 * snapshot, so already-published Agents keep calling the configuration they were
 * published with. An omitted or empty `bearerToken` keeps the stored credential.
 */
export const ToolUpdate = ToolInput.extend({
  bearerToken: Credential.optional(),
}).openapi("ToolUpdate");
/**
 * Each failure names a different fix, so they are never collapsed into one
 * "failed" verdict:
 * - `invalid`    the sample arguments do not satisfy the declared input schema; nothing was sent.
 * - `rejected`   the service refused the call, or answered with something that is not JSON.
 * - `mismatch`   the service answered 200 with JSON the declared output schema does not accept,
 *                which is the one failure an operator fixes by editing the schema.
 */
export const ToolProbeOutcome = z.enum([
  "ok",
  "invalid",
  "rejected",
  "mismatch",
  "unreachable",
  "timeout",
]);
export const ToolProbeInput = z
  .object({
    kind: AuthoredToolKind.default("sum"),
    url: z.string().max(500).default(""),
    /** Used when supplied; otherwise the saved credential of `credentialFrom` is used. */
    bearerToken: Credential.optional(),
    /** Reuse a saved credential while editing, without re-entering the token. */
    credentialFrom: Id.optional(),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    /** The sample arguments to call the tool with; validated before any request is sent. */
    input: JsonSchema.default({}),
  })
  .strict()
  .openapi("ToolProbeInput");
export const ToolProbe = z
  .object({
    outcome: ToolProbeOutcome,
    httpStatus: z.number().int().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    /** Bounded transport or provider text, reported as it arrived. */
    message: z.string().max(500),
    /**
     * The exact URL the platform called, including how the sample arguments were
     * encoded. Null when nothing was sent.
     */
    requestUrl: z.string().max(2000).nullable(),
    /**
     * A bounded rendering of what the Runtime would have returned. Present so an
     * operator can correct a schema against the real shape instead of guessing;
     * it is the same payload the Agent would receive, never a stored record.
     */
    preview: z.string().max(1000).nullable(),
  })
  .openapi("ToolProbe");
/** Parsed shapes: routes hand these to the domain layer after zod has applied the defaults. */
export type ToolInput = z.infer<typeof ToolInput>;
export type ToolProbe = z.infer<typeof ToolProbe>;
export type ToolProbeInput = z.infer<typeof ToolProbeInput>;
export type ToolUpdate = z.infer<typeof ToolUpdate>;
