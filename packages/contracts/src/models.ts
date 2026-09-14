import { Credential, Id, z } from "./common.ts";
export const ModelKind = z.enum(["chat", "embedding", "rerank"]);
/**
 * Where the service comes from. `custom` covers any OpenAI-compatible endpoint,
 * including self-hosted ones, and is the only value used when nothing was chosen.
 * The vendor is recorded so the console can show where a model points and offer
 * the matching base URL; it never changes how a request is made.
 */
export const ModelVendor = z
  .enum([
    "custom",
    "openai",
    "deepseek",
    "moonshot",
    "zhipu",
    "dashscope",
    "volcengine",
    "siliconflow",
    "minimax",
    "qianfan",
    "openrouter",
    "ollama",
  ])
  .openapi("ModelVendor");
/**
 * Declared by the operator, never detected. `toolUse` is compared against an
 * Agent's bound tools so a mismatch is visible before publishing. `vision` is a
 * selection aid only: conversations do not accept image input yet, so it never
 * changes what the Runtime sends, and the console says so where it is offered.
 */
export const ModelCapabilities = z
  .object({
    vision: z.boolean().default(false),
    toolUse: z.boolean().default(true),
  })
  .strict()
  .openapi("ModelCapabilities");
/**
 * One entry of the platform's vendor catalogue. `baseUrl` is null when the
 * vendor has no single public endpoint, and `note` carries what an operator must
 * know before the address works — those constraints are not discoverable from
 * the URL alone.
 */
export const ModelVendorPreset = z
  .object({
    vendor: ModelVendor,
    label: z.string(),
    baseUrl: z.url().nullable(),
    note: z.string(),
  })
  .openapi("ModelVendorPreset");
export const ModelInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseUrl: z.url().max(500),
    kind: ModelKind.default("chat"),
    vendor: ModelVendor.default("custom"),
    /**
     * `prefault` rather than `default`: a stored row written before this field
     * existed parses through the inner defaults instead of receiving a bare `{}`
     * that its own schema would then reject.
     */
    capabilities: ModelCapabilities.prefault({}),
    dimensions: z.number().int().min(1).max(16000).optional(),
    modelId: z.string().min(1).max(200),
    apiKey: Credential.default(""),
  })
  .strict()
  .openapi("ModelInput");
export const Model = ModelInput.omit({ apiKey: true })
  .extend({
    id: Id,
    projectId: Id,
    hasCredential: z.boolean(),
    createdAt: z.string(),
    provider: z.literal("openai-compatible"),
  })
  .openapi("Model");
export const ModelUpdate = ModelInput.extend({
  /** Omitted or empty keeps the stored credential; it is never echoed back. */
  apiKey: Credential.optional(),
}).openapi("ModelUpdate");
/** `unreachable` describes the platform's own network, not the Runtime's. */
export const ModelProbeOutcome = z.enum(["ok", "rejected", "unreachable", "timeout"]);
export const ModelProbeInput = z
  .object({
    kind: ModelKind.default("chat"),
    baseUrl: z.url().max(500),
    modelId: z.string().min(1).max(200),
    dimensions: z.number().int().min(1).max(16000).optional(),
    /** Used when supplied; otherwise the saved credential of `credentialFrom` is used. */
    apiKey: Credential.optional(),
    /** Reuse a saved credential while editing, without re-entering the key. */
    credentialFrom: Id.optional(),
  })
  .strict()
  .openapi("ModelProbeInput");
export const ModelProbe = z
  .object({
    outcome: ModelProbeOutcome,
    httpStatus: z.number().int().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    /** Bounded transport or provider text, reported as it arrived. */
    message: z.string().max(500),
    /** The embedding length the service actually returned. */
    dimensions: z.number().int().positive().nullable(),
  })
  .openapi("ModelProbe");
/**
 * `unsupported` means the service answered but exposes no model catalogue, which
 * is a normal property of many self-hosted deployments and not a misconfiguration.
 */
export const ModelDiscoveryOutcome = z.enum([
  "ok",
  "unsupported",
  "rejected",
  "unreachable",
  "timeout",
]);
export const ModelDiscoverInput = z
  .object({
    baseUrl: z.url().max(500),
    /** Used when supplied; otherwise the saved credential of `credentialFrom` is used. */
    apiKey: Credential.optional(),
    credentialFrom: Id.optional(),
  })
  .strict()
  .openapi("ModelDiscoverInput");
export const ModelDiscovery = z
  .object({
    outcome: ModelDiscoveryOutcome,
    httpStatus: z.number().int().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    message: z.string().max(500),
    /**
     * Model identifiers exactly as the service reported them, bounded to the
     * length a model id may have. Reported ids are candidates to choose from,
     * never a claim about which capabilities they have.
     */
    models: z.array(z.string().min(1).max(200)).max(2000),
  })
  .openapi("ModelDiscovery");
export type ModelInput = z.input<typeof ModelInput>;
export type ModelDiscovery = z.infer<typeof ModelDiscovery>;
export type ModelDiscoverInput = z.infer<typeof ModelDiscoverInput>;
export type ModelProbe = z.infer<typeof ModelProbe>;
export type ModelProbeInput = z.infer<typeof ModelProbeInput>;
export type ModelUpdate = z.infer<typeof ModelUpdate>;
export type ModelVendor = z.infer<typeof ModelVendor>;
export type ModelVendorPreset = z.infer<typeof ModelVendorPreset>;
