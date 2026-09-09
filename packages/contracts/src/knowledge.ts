import { Id, z } from "./common.ts";
import { Model } from "./models.ts";
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
