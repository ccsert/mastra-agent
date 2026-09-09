import { MDocument } from "@mastra/rag";
import {
  EmbeddingVector,
  type KnowledgeJob,
  type KnowledgeSnapshot,
  type Model,
  SearchHit,
  z,
} from "@platform/contracts";
export type RuntimePost = (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;

async function modelJson(
  model: z.infer<typeof Model>,
  key: string | undefined,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("MODEL_ERROR");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("INVALID_MODEL_RESPONSE");
  const buffers: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8388608) {
      await reader.cancel();
      throw new Error("INVALID_MODEL_RESPONSE");
    }
    buffers.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_MODEL_RESPONSE");
  }
}
export async function embed(
  model: z.infer<typeof Model>,
  keys: Record<string, string>,
  texts: string[],
  signal: AbortSignal,
) {
  const raw = await modelJson(
    model,
    keys[model.id],
    "/embeddings",
    {
      model: model.modelId,
      input: texts,
      encoding_format: "float",
      ...(model.dimensions ? { dimensions: model.dimensions } : {}),
    },
    signal,
  );
  const result = z
    .object({
      data: z.array(
        z.object({ index: z.number().int().nonnegative(), embedding: EmbeddingVector }),
      ),
    })
    .safeParse(raw);
  if (!result.success) throw new Error("INVALID_MODEL_RESPONSE");
  const rows = result.data.data.sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length || rows.some((r, i) => r.index !== i))
    throw new Error("INVALID_MODEL_RESPONSE");
  const dimensions = model.dimensions ?? rows[0].embedding.length;
  if (rows.some((r) => r.embedding.length !== dimensions)) throw new Error("DIMENSION_MISMATCH");
  return rows.map((r) => r.embedding);
}
export async function retrieve(
  snapshot: z.infer<typeof KnowledgeSnapshot>,
  keys: Record<string, string>,
  query: string,
  topK: number,
  signal: AbortSignal,
  candidates: (vector: number[]) => Promise<unknown>,
) {
  const [vector] = await embed(snapshot.embeddingModel, keys, [query], signal);
  const response = z.object({ hits: z.array(SearchHit) }).parse(await candidates(vector));
  if (!response.hits.length) return [];
  if (!snapshot.rerankModel) return response.hits.slice(0, topK);
  const raw = await modelJson(
    snapshot.rerankModel,
    keys[snapshot.rerankModel.id],
    "/rerank",
    {
      model: snapshot.rerankModel.modelId,
      query,
      documents: response.hits.map((h) => h.content),
      top_n: Math.min(topK, response.hits.length),
    },
    signal,
  );
  const result = z
    .object({
      results: z.array(
        z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() }),
      ),
    })
    .safeParse(raw);
  if (!result.success) throw new Error("INVALID_MODEL_RESPONSE");
  const ranks = result.data.results;
  if (
    ranks.length > topK ||
    ranks.some((r) => r.index >= response.hits.length) ||
    new Set(ranks.map((r) => r.index)).size !== ranks.length
  )
    throw new Error("INVALID_MODEL_RESPONSE");
  return ranks
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map((r) => ({ ...response.hits[r.index], rerankScore: r.relevance_score }));
}
export async function executeKnowledgeJob(
  job: KnowledgeJob,
  signal: AbortSignal,
  post: RuntimePost,
) {
  const path = `/internal/runtime/knowledge/${job.id}`;
  if (job.kind === "search") {
    if (!job.search) throw new Error("RUNTIME_ERROR");
    const results = await retrieve(
      job.snapshot,
      job.credentials,
      job.search.query,
      job.search.topK,
      signal,
      (vector) =>
        post(
          `${path}/query`,
          { leaseToken: job.leaseToken, knowledgeBaseId: job.snapshot.id, vector },
          signal,
        ),
    );
    return { leaseToken: job.leaseToken, status: "succeeded" as const, results };
  }
  if (!job.document) throw new Error("RUNTIME_ERROR");
  const doc = MDocument.fromText(job.document.content);
  const chunks = await doc.chunk({
    strategy: "recursive",
    maxSize: job.snapshot.chunkSize,
    overlap: job.snapshot.chunkOverlap,
    separators: ["\n\n", "\n", "。", "；", " ", ""],
  });
  if (!chunks.length || chunks.length > 256) throw new Error("DOCUMENT_TOO_LARGE");
  for (let start = 0; start < chunks.length; start += 8) {
    signal.throwIfAborted();
    const group = chunks.slice(start, start + 8),
      vectors = await embed(
        job.snapshot.embeddingModel,
        job.credentials,
        group.map((c) => c.text),
        signal,
      );
    await post(
      `${path}/chunks`,
      {
        leaseToken: job.leaseToken,
        chunks: group.map((c, i) => ({ ordinal: start + i, content: c.text, vector: vectors[i] })),
      },
      signal,
    );
  }
  return { leaseToken: job.leaseToken, status: "succeeded" as const, chunkCount: chunks.length };
}
