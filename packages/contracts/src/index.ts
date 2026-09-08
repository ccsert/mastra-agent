import { z } from "@hono/zod-openapi";

export { z };
export const Id = z.uuid();
export const ErrorBody = z.object({ code: z.string(), message: z.string() }).openapi("ApiError");
export const ProjectInput = z
  .object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default("") })
  .strict()
  .openapi("ProjectInput");
export const Project = ProjectInput.extend({ id: Id, tenantId: Id, createdAt: z.string() }).openapi(
  "Project",
);
export const Credential = z.string().max(4096);
export const ModelInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseUrl: z.url().max(500),
    kind: z.enum(["chat", "embedding", "rerank"]).default("chat"),
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
export const KnowledgeInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    embeddingModelId: Id,
    rerankModelId: Id.nullable().default(null),
    chunkSize: z.number().int().min(200).max(2000).default(800),
    chunkOverlap: z.number().int().min(0).max(100).default(80),
  })
  .strict()
  .openapi("KnowledgeInput");
export const KnowledgeSnapshot = z.object({
  id: Id,
  name: z.string(),
  embeddingModel: Model,
  rerankModel: Model.nullable(),
  chunkSize: z.number().int(),
  chunkOverlap: z.number().int(),
});
export const KnowledgeBase = KnowledgeInput.extend({
  id: Id,
  projectId: Id,
  dimensions: z.number().int().nullable(),
  documentCount: z.number().int(),
  readyCount: z.number().int(),
  chunkCount: z.number().int(),
  createdAt: z.string(),
}).openapi("KnowledgeBase");
export const DocumentInput = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^/\\]+\.(txt|md)$/i)
      .refine((name) => [...name].every((c) => c.charCodeAt(0) >= 32)),
    content: z
      .string()
      .min(1)
      .max(200000)
      .refine((s) => s.trim().length > 0 && !s.includes("\0")),
  })
  .strict()
  .openapi("DocumentInput");
export const KnowledgeDocument = z
  .object({
    id: Id,
    knowledgeBaseId: Id,
    filename: z.string(),
    contentHash: z.string(),
    status: z.enum(["queued", "processing", "ready", "failed", "deleted"]),
    chunkCount: z.number().int(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("KnowledgeDocument");
export const KnowledgeChunk = z
  .object({
    id: Id,
    documentId: Id,
    knowledgeBaseId: Id,
    filename: z.string(),
    ordinal: z.number().int(),
    content: z.string(),
    contentHash: z.string(),
  })
  .openapi("KnowledgeChunk");
export const SearchHit = KnowledgeChunk.extend({
  similarity: z.number(),
  rerankScore: z.number().nullable(),
}).openapi("SearchHit");
export const SearchInput = z
  .object({
    query: z.string().trim().min(1).max(2000),
    topK: z.number().int().min(1).max(10).default(5),
  })
  .strict()
  .openapi("SearchInput");
export const KnowledgeSearch = z
  .object({
    id: Id,
    knowledgeBaseId: Id,
    query: z.string(),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    results: z.array(SearchHit),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("KnowledgeSearch");
export const EmbeddingVector = z
  .array(z.number().min(-3.4e38).max(3.4e38))
  .min(1)
  .max(16000)
  .refine((v) => v.some((n) => n !== 0), "Vector cannot be zero");
export const JsonSchema = z.record(z.string(), z.unknown()).openapi("JsonSchema");
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
    id: Id,
    projectId: Id,
    hasCredential: z.boolean(),
    createdAt: z.string(),
    version: z.literal(1),
  })
  .openapi("Tool");
export const AgentInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    instructions: z.string().trim().min(1).max(16000),
    modelId: Id,
    toolIds: z.array(Id).max(20),
    knowledgeBaseIds: z.array(Id).max(5).default([]),
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
export const ConversationInput = z
  .object({ agentId: Id, title: z.string().trim().min(1).max(100).default("新会话") })
  .strict()
  .openapi("ConversationInput");
export const Conversation = z
  .object({
    id: Id,
    agentId: Id,
    projectId: Id,
    releaseId: Id,
    releaseVersion: z.number().int(),
    title: z.string(),
    createdAt: z.string(),
  })
  .openapi("Conversation");
export const Message = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("Message");
export const RunInput = z
  .object({
    conversationId: Id,
    input: z.string().trim().min(1).max(16000),
    requestId: z.string().min(1).max(100),
  })
  .strict()
  .openapi("RunInput");
export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const Run = z
  .object({
    id: Id,
    conversationId: Id,
    releaseId: Id,
    releaseVersion: z.number().int(),
    agentName: z.string(),
    status: RunStatus,
    runtimeId: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    outputText: z.string().nullable(),
  })
  .openapi("Run");
export const RunEvent = z
  .object({
    seq: z.number().int(),
    chunk: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("RunEvent");
export const RuntimeInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    lastSeenAt: z.string().nullable(),
    online: z.boolean(),
  })
  .openapi("RuntimeInfo");
export const Application = z
  .object({
    id: Id,
    projectId: Id,
    name: z.string(),
    accessKey: z.string(),
    active: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Application");
export const Principal = z
  .object({
    id: Id,
    tenantId: Id,
    displayName: z.string(),
    kind: z.enum(["user", "application"]),
    projectId: Id.optional(),
    entry: z.string(),
  })
  .openapi("Principal");
export type Principal = z.infer<typeof Principal>;
export type ModelInput = z.input<typeof ModelInput>;
export type ToolInput = z.infer<typeof ToolInput>;
export type AgentInput = z.input<typeof AgentInput>;
export const ExecutionJob = z.object({
  runId: Id,
  leaseToken: z.string(),
  snapshot: ReleaseSnapshot,
  messages: z.array(Message),
  credentials: z.object({
    modelApiKey: z.string(),
    toolTokens: z.record(z.string(), z.string()),
    knowledgeModelKeys: z.record(z.string(), z.string()).default({}),
  }),
  deadline: z.number(),
});
export type ExecutionJob = z.infer<typeof ExecutionJob>;
export const KnowledgeJob = z.object({
  id: Id,
  leaseToken: z.string(),
  kind: z.enum(["ingest", "search"]),
  snapshot: KnowledgeSnapshot,
  document: DocumentInput.extend({ id: Id }).nullable(),
  search: SearchInput.nullable(),
  credentials: z.record(z.string(), z.string()),
  deadline: z.number(),
});
export type KnowledgeJob = z.infer<typeof KnowledgeJob>;
export const KnowledgeBatch = z
  .object({
    leaseToken: z.string(),
    chunks: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(0).max(255),
            content: z.string().min(1).max(2000),
            vector: EmbeddingVector,
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const VectorQuery = z
  .object({
    leaseToken: z.string(),
    vector: EmbeddingVector,
    knowledgeBaseId: Id,
  })
  .strict();
export const KnowledgeFinish = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed"]),
    chunkCount: z.number().int().min(1).max(256).optional(),
    results: z.array(SearchHit).max(10).optional(),
    errorCode: z
      .enum([
        "MODEL_ERROR",
        "INVALID_MODEL_RESPONSE",
        "DIMENSION_MISMATCH",
        "DOCUMENT_TOO_LARGE",
        "TIMEOUT",
        "RUNTIME_ERROR",
      ])
      .optional(),
  })
  .strict();
export const RuntimeEventInput = z
  .object({
    leaseToken: z.string(),
    seq: z.number().int().nonnegative(),
    chunk: z.record(z.string(), z.unknown()),
  })
  .strict();
export const RuntimeFinishInput = z
  .object({
    leaseToken: z.string(),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    message: Message.optional(),
    outputText: z.string().max(200000).optional(),
    errorCode: z.enum(["MODEL_ERROR", "RUNTIME_ERROR", "TIMEOUT", "CANCELLED"]).optional(),
  })
  .strict();
