import { randomUUID } from "node:crypto";
import {
  type DocumentInput,
  KnowledgeBase,
  type KnowledgeBatch,
  KnowledgeChunk,
  KnowledgeDocument,
  type KnowledgeFinish,
  type KnowledgeInput,
  KnowledgeJob,
  KnowledgeSearch,
  KnowledgeSnapshot,
  type Principal,
  ReleaseSnapshot,
  SearchHit,
  type SearchInput,
  type VectorQuery,
  z,
} from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import type { ExecutionContext } from "../../infrastructure/execution-context.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import type { Projects } from "../projects/index.ts";
import { requireUser } from "../projects/index.ts";
import { modelDto, type Resources } from "../resources/index.ts";

const date = (v: unknown) => new Date(String(v)).toISOString();
const documentDto = (r: Row) =>
  KnowledgeDocument.parse({
    id: r.id,
    knowledgeBaseId: r.knowledge_base_id,
    filename: r.filename,
    contentHash: r.content_hash,
    status: r.status,
    chunkCount: r.chunk_count,
    errorCode: r.error_code,
    createdAt: date(r.created_at),
  });
const searchDto = (r: Row) =>
  KnowledgeSearch.parse({
    id: r.id,
    knowledgeBaseId: r.knowledge_base_id,
    query: (r.input as Record<string, unknown>).query,
    status: r.status,
    results: r.results,
    errorCode: r.error_code,
    createdAt: date(r.created_at),
  });
const chunkDto = (r: Row) =>
  KnowledgeChunk.parse({
    id: r.id,
    documentId: r.document_id,
    knowledgeBaseId: r.knowledge_base_id,
    filename: r.filename,
    contentHash: r.content_hash,
    ordinal: r.ordinal,
    content: r.content,
  });
const expired = () => new ApiError(409, "LEASE_EXPIRED", "任务租约已失效");

/** Hosted knowledge lifecycle. All model I/O remains in the assigned Runtime. */
export class Knowledge {
  constructor(readonly deps: ExecutionContext & { projects: Projects; resources: Resources }) {}
  get db() {
    return this.deps.db;
  }
  private async scope(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT * FROM knowledge_bases WHERE id=$1 AND project_id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id, projectId],
    );
    if (!r) throw notFound();
    return r;
  }
  async list(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    const rows = await this.db.query(
      `SELECT k.*, count(d.id)::int AS document_count,
      count(d.id) FILTER(WHERE d.status='ready')::int AS ready_count,
      coalesce(sum(d.chunk_count) FILTER(WHERE d.status='ready'),0)::int AS chunk_count
      FROM knowledge_bases k LEFT JOIN knowledge_documents d ON d.knowledge_base_id=k.id AND d.status<>'deleted'
      WHERE k.project_id=$1 GROUP BY k.id ORDER BY k.created_at DESC`,
      [projectId],
    );
    return rows.map((r) =>
      KnowledgeBase.parse({
        ...(r.data as object),
        id: r.id,
        projectId: r.project_id,
        dimensions: r.dimensions,
        documentCount: r.document_count,
        readyCount: r.ready_count,
        chunkCount: r.chunk_count,
        createdAt: date(r.created_at),
      }),
    );
  }
  async create(actor: Principal, projectId: string, input: z.infer<typeof KnowledgeInput>) {
    requireUser(actor);
    const embedding = modelDto(
      await this.deps.resources.get(actor, projectId, input.embeddingModelId, "model"),
    );
    if (embedding.kind !== "embedding") throw new ApiError(400, "MODEL_KIND", "请选择向量模型");
    if (
      input.rerankModelId &&
      modelDto(await this.deps.resources.get(actor, projectId, input.rerankModelId, "model"))
        .kind !== "rerank"
    )
      throw new ApiError(400, "MODEL_KIND", "请选择重排模型");
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO knowledge_bases(id,tenant_id,project_id,data,dimensions) VALUES($1,$2,$3,$4,$5)",
      [id, actor.tenantId, projectId, input, embedding.dimensions ?? null],
    );
    const result = (await this.list(actor, projectId)).find((k) => k.id === id);
    if (!result) throw notFound();
    return result;
  }
  async documents(actor: Principal, projectId: string, kbId: string, input: PageInput = {}) {
    await this.scope(actor, projectId, kbId);
    const page = cursorPage(["knowledge-documents", actor.tenantId, projectId, kbId], input);
    const rows = await this.db.query(
      `SELECT d.id,d.knowledge_base_id,d.filename,d.content_hash,d.status,d.chunk_count,d.error_code,d.created_at,${page.select("d")}
       FROM knowledge_documents d WHERE d.knowledge_base_id=$1 AND d.status<>'deleted'
         AND ${page.where("d", 2)} ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,
      [kbId, ...page.values],
    );
    return page.result(rows, documentDto);
  }
  async chunks(actor: Principal, projectId: string, kbId: string, docId: string) {
    await this.scope(actor, projectId, kbId);
    return (
      await this.db.query(
        `SELECT c.*,d.filename,d.content_hash FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.job_id=c.job_id WHERE c.knowledge_base_id=$1 AND c.document_id=$2 AND d.status='ready' ORDER BY c.ordinal`,
        [kbId, docId],
      )
    ).map(chunkDto);
  }
  private async enqueue(
    tx: Queryable,
    actor: Principal,
    projectId: string,
    kbId: string,
    kind: "ingest" | "search",
    input: unknown,
    docId: string | null,
    id = randomUUID(),
  ) {
    const snapshot = await this.deps.resources.knowledgeSnapshot(actor, projectId, kbId, tx);
    const [r] = await tx.query(
      `INSERT INTO knowledge_jobs(id,knowledge_base_id,actor_id,entry,runtime_id,kind,document_id,input,snapshot,status,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',now()+interval '5 minutes') RETURNING *`,
      [id, kbId, actor.id, actor.entry, this.deps.runtimeId, kind, docId, input, snapshot],
    );
    return r;
  }
  async upload(
    actor: Principal,
    projectId: string,
    kbId: string,
    input: z.infer<typeof DocumentInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await this.scope(actor, projectId, kbId, tx, true);
      const hash = sha256(input.content),
        [existing] = await tx.query(
          "SELECT * FROM knowledge_documents WHERE knowledge_base_id=$1 AND content_hash=$2 AND status<>'deleted'",
          [kbId, hash],
        );
      if (existing) return documentDto(existing);
      const [count] = await tx.query(
        "SELECT count(*)::int AS n FROM knowledge_documents WHERE knowledge_base_id=$1 AND status<>'deleted'",
        [kbId],
      );
      if (Number(count.n) >= 200)
        throw new ApiError(409, "KNOWLEDGE_CAPACITY", "当前知识库最多保存 200 份文档");
      const id = randomUUID(),
        jobId = randomUUID();
      const [doc] = await tx.query(
        "INSERT INTO knowledge_documents(id,knowledge_base_id,filename,content,content_hash,status,job_id) VALUES($1,$2,$3,$4,$5,'queued',$6) RETURNING *",
        [id, kbId, input.filename, input.content, hash, jobId],
      );
      await this.enqueue(tx, actor, projectId, kbId, "ingest", {}, id, jobId);
      return documentDto(doc);
    });
  }
  async retry(actor: Principal, projectId: string, kbId: string, docId: string) {
    return this.db.transaction(async (tx) => {
      await this.scope(actor, projectId, kbId, tx, true);
      const [doc] = await tx.query(
        "SELECT * FROM knowledge_documents WHERE id=$1 AND knowledge_base_id=$2 FOR UPDATE",
        [docId, kbId],
      );
      if (!doc) throw notFound();
      if (doc.status !== "failed")
        throw new ApiError(409, "DOCUMENT_STATE", "仅失败的文档可以重试");
      const jobId = randomUUID();
      await this.enqueue(tx, actor, projectId, kbId, "ingest", {}, docId, jobId);
      await tx.query("DELETE FROM knowledge_chunks WHERE document_id=$1", [docId]);
      const [updated] = await tx.query(
        "UPDATE knowledge_documents SET status='queued',job_id=$1,error_code=NULL,chunk_count=0 WHERE id=$2 RETURNING *",
        [jobId, docId],
      );
      return documentDto(updated);
    });
  }
  async removeDocument(actor: Principal, projectId: string, kbId: string, docId: string) {
    await this.db.transaction(async (tx) => {
      await this.scope(actor, projectId, kbId, tx, true);
      const [doc] = await tx.query(
        "SELECT * FROM knowledge_documents WHERE id=$1 AND knowledge_base_id=$2",
        [docId, kbId],
      );
      if (!doc) throw notFound();
      await tx.query(
        "UPDATE knowledge_jobs SET status='cancelled',finished_at=now() WHERE id=$1 AND status IN ('queued','running')",
        [doc.job_id],
      );
      await tx.query(
        "UPDATE knowledge_documents SET status='deleted',content='',chunk_count=0 WHERE id=$1",
        [docId],
      );
      await tx.query("DELETE FROM knowledge_chunks WHERE document_id=$1", [docId]);
    });
  }
  async search(
    actor: Principal,
    projectId: string,
    kbId: string,
    input: z.infer<typeof SearchInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await this.scope(actor, projectId, kbId, tx, true);
      const [count] = await tx.query(
        "SELECT count(*)::int AS n FROM knowledge_jobs WHERE knowledge_base_id=$1 AND kind='search' AND status IN ('queued','running')",
        [kbId],
      );
      if (Number(count.n) >= 10) throw new ApiError(429, "SEARCH_BUSY", "检索任务较多，请稍后重试");
      return searchDto(await this.enqueue(tx, actor, projectId, kbId, "search", input, null));
    });
  }
  async getSearch(actor: Principal, projectId: string, kbId: string, id: string) {
    await this.scope(actor, projectId, kbId);
    const [r] = await this.db.query(
      "SELECT * FROM knowledge_jobs WHERE id=$1 AND knowledge_base_id=$2 AND actor_id=$3 AND entry=$4 AND kind='search'",
      [id, kbId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return searchDto(r);
  }
  async claim(): Promise<KnowledgeJob | null> {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        "SELECT j.*,k.project_id,k.tenant_id FROM knowledge_jobs j JOIN knowledge_bases k ON k.id=j.knowledge_base_id WHERE j.runtime_id=$1 AND j.status='queued' AND j.deadline>now() ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1",
        [this.deps.runtimeId],
      );
      if (!r) return null;
      const leaseToken = randomUUID(),
        snapshot = KnowledgeSnapshot.parse(r.snapshot),
        credentials: Record<string, string> = {};
      for (const model of [snapshot.embeddingModel, snapshot.rerankModel].filter(
        (m) => m !== null,
      )) {
        const [resource] = await tx.query(
          "SELECT secret_enc FROM resources WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND kind='model'",
          [model.id, r.project_id, r.tenant_id],
        );
        if (!resource) throw new ApiError(409, "DEPENDENCY_UNAVAILABLE", "知识库模型不可用");
        credentials[model.id] = this.deps.vault.decrypt(String(resource.secret_enc));
      }
      await tx.query(
        "UPDATE knowledge_jobs SET status='running',lease_token=$1,lease_until=now()+interval '20 seconds' WHERE id=$2",
        [leaseToken, r.id],
      );
      let document = null;
      if (r.kind === "ingest") {
        const [doc] = await tx.query(
          "UPDATE knowledge_documents SET status='processing' WHERE id=$1 AND job_id=$2 AND status='queued' RETURNING *",
          [r.document_id, r.id],
        );
        if (!doc) throw expired();
        document = { id: doc.id, filename: doc.filename, content: doc.content };
      }
      return KnowledgeJob.parse({
        id: r.id,
        leaseToken,
        kind: r.kind,
        snapshot,
        document,
        search: r.kind === "search" ? r.input : null,
        credentials,
        deadline: new Date(String(r.deadline)).getTime(),
      });
    });
  }
  private async active(tx: Queryable, id: string, token: string) {
    const [r] = await tx.query(
      "SELECT * FROM knowledge_jobs WHERE id=$1 AND runtime_id=$2 FOR UPDATE",
      [id, this.deps.runtimeId],
    );
    await this.checkLease(tx, r, token);
    return r;
  }
  private async checkLease(tx: Queryable, r: Row | undefined, token: string) {
    if (r?.status !== "running" || r.lease_token !== token) throw expired();
    // Read the database wall clock after acquiring the lock: transaction time may be stale.
    const [clock] = await tx.query(
      "SELECT clock_timestamp() < $1::timestamptz AND clock_timestamp() < $2::timestamptz AS valid",
      [r.lease_until, r.deadline],
    );
    if (!clock.valid) throw expired();
  }
  async renew(id: string, token: string) {
    await this.db.transaction(async (tx) => {
      await this.active(tx, id, token);
      await tx.query(
        "UPDATE knowledge_jobs SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1",
        [id],
      );
    });
    await this.db.query("UPDATE runtimes SET last_seen_at=now() WHERE id=$1", [
      this.deps.runtimeId,
    ]);
  }
  async batch(id: string, input: z.infer<typeof KnowledgeBatch>) {
    await this.db.transaction(async (tx) => {
      // The catalog lock serializes dimension adoption and capacity accounting across documents.
      const [kb] = await tx.query(
        "SELECT k.* FROM knowledge_bases k JOIN knowledge_jobs j ON j.knowledge_base_id=k.id WHERE j.id=$1 FOR UPDATE OF k",
        [id],
      );
      const job = await this.active(tx, id, input.leaseToken);
      if (job.kind !== "ingest" || !kb) throw notFound();
      const dimensions = Number(kb.dimensions ?? input.chunks[0].vector.length);
      if (input.chunks.some((c) => c.vector.length !== dimensions))
        throw new ApiError(409, "DIMENSION_MISMATCH", "向量维度与知识库固定配置不一致");
      await tx.query(
        "UPDATE knowledge_bases SET dimensions=$1 WHERE id=$2 AND dimensions IS NULL",
        [dimensions, kb.id],
      );
      for (const chunk of input.chunks) {
        const vector = JSON.stringify(chunk.vector);
        const [existing] = await tx.query(
          "SELECT content=$3 AND embedding=$4::public.vector AS same FROM knowledge_chunks WHERE job_id=$1 AND ordinal=$2",
          [id, chunk.ordinal, chunk.content, vector],
        );
        if (existing) {
          if (!existing.same) throw new ApiError(409, "CHUNK_CONFLICT", "重复分段的内容不一致");
          continue;
        }
        const [count] = await tx.query(
          "SELECT count(*)::int AS n FROM knowledge_chunks WHERE knowledge_base_id=$1",
          [kb.id],
        );
        if (Number(count.n) >= 10000)
          throw new ApiError(409, "KNOWLEDGE_CAPACITY", "知识库分段超过当前容量限制");
        await tx.query(
          "INSERT INTO knowledge_chunks(id,knowledge_base_id,document_id,job_id,ordinal,content,embedding) VALUES($1,$2,$3,$4,$5,$6,$7::public.vector)",
          [randomUUID(), kb.id, job.document_id, id, chunk.ordinal, chunk.content, vector],
        );
      }
    });
  }
  async nearest(tx: Queryable, kbId: string, vector: number[]) {
    const [kb] = await tx.query("SELECT dimensions FROM knowledge_bases WHERE id=$1", [kbId]);
    if (!kb) throw notFound();
    if (kb.dimensions === null) return [];
    if (Number(kb.dimensions) !== vector.length)
      throw new ApiError(409, "DIMENSION_MISMATCH", "查询向量维度不一致");
    // Exact cosine search keeps full float precision and strict KB filtering for this bounded slice.
    const rows = await tx.query(
      `WITH eligible AS MATERIALIZED (
      SELECT c.*,d.filename,d.content_hash FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.job_id=c.job_id
      WHERE c.knowledge_base_id=$1 AND d.status='ready')
      SELECT *,1-(embedding <=> $2::public.vector) AS similarity FROM eligible ORDER BY embedding <=> $2::public.vector,id LIMIT 20`,
      [kbId, JSON.stringify(vector)],
    );
    return rows.map((r) =>
      SearchHit.parse({ ...chunkDto(r), similarity: Number(r.similarity), rerankScore: null }),
    );
  }
  async queryJob(id: string, input: z.infer<typeof VectorQuery>) {
    return this.db.transaction(async (tx) => {
      const job = await this.active(tx, id, input.leaseToken);
      if (job.kind !== "search" || job.knowledge_base_id !== input.knowledgeBaseId)
        throw notFound();
      const hits = await this.nearest(tx, input.knowledgeBaseId, input.vector);
      await tx.query("UPDATE knowledge_jobs SET candidates=$1 WHERE id=$2", [
        JSON.stringify(hits),
        id,
      ]);
      return hits;
    });
  }
  async queryAgent(id: string, input: z.infer<typeof VectorQuery>) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        "SELECT r.*,v.snapshot FROM runs r JOIN releases v ON v.id=r.release_id AND v.project_id=r.project_id WHERE r.id=$1 AND r.runtime_id=$2 FOR UPDATE OF r",
        [id, this.deps.runtimeId],
      );
      await this.checkLease(tx, r, input.leaseToken);
      if (r.cancel_requested) throw expired();
      if (
        !ReleaseSnapshot.parse(r.snapshot).knowledgeBases.some(
          (k) => k.id === input.knowledgeBaseId,
        )
      )
        throw notFound();
      return this.nearest(tx, input.knowledgeBaseId, input.vector);
    });
  }
  async finish(id: string, input: z.infer<typeof KnowledgeFinish>) {
    await this.db.transaction(async (tx) => {
      const job = await this.active(tx, id, input.leaseToken);
      let results: z.infer<typeof SearchHit>[] = [];
      if (input.status === "succeeded" && job.kind === "ingest") {
        const [stats] = await tx.query(
          "SELECT count(*)::int AS n,min(ordinal) AS first,max(ordinal) AS last FROM knowledge_chunks WHERE job_id=$1",
          [id],
        );
        if (
          !input.chunkCount ||
          stats.n !== input.chunkCount ||
          stats.first !== 0 ||
          stats.last !== input.chunkCount - 1
        )
          throw new ApiError(409, "INCOMPLETE_DOCUMENT", "分段尚未完整提交");
        await tx.query(
          "UPDATE knowledge_documents SET status='ready',chunk_count=$1,error_code=NULL WHERE id=$2 AND job_id=$3",
          [input.chunkCount, job.document_id, id],
        );
      } else if (input.status === "succeeded") {
        const candidates = z.array(SearchHit).parse(job.candidates),
          selected = input.results ?? [];
        if (
          selected.length > Number((job.input as Record<string, unknown>).topK) ||
          new Set(selected.map((h) => h.id)).size !== selected.length
        )
          throw new ApiError(400, "INVALID_RESULTS", "检索结果不符合本次任务范围");
        results = selected.map((hit) => {
          const original = candidates.find((c) => c.id === hit.id);
          if (!original) throw new ApiError(400, "INVALID_RESULTS", "检索结果不符合本次任务范围");
          return { ...original, rerankScore: hit.rerankScore };
        });
      } else if (job.kind === "ingest") {
        await tx.query("DELETE FROM knowledge_chunks WHERE job_id=$1", [id]);
        await tx.query(
          "UPDATE knowledge_documents SET status='failed',chunk_count=0,error_code=$1 WHERE id=$2 AND job_id=$3",
          [input.errorCode ?? "RUNTIME_ERROR", job.document_id, id],
        );
      }
      await tx.query(
        "UPDATE knowledge_jobs SET status=$1,results=$2,error_code=$3,finished_at=now() WHERE id=$4",
        [
          input.status,
          JSON.stringify(results),
          input.status === "succeeded" ? null : (input.errorCode ?? "RUNTIME_ERROR"),
          id,
        ],
      );
    });
  }
  async reap() {
    await this.db.transaction(async (tx) => {
      const expiredJobs = await tx.query(
        "UPDATE knowledge_jobs SET status='failed',error_code=CASE WHEN status='queued' THEN 'RUNTIME_UNAVAILABLE' ELSE 'RUNTIME_LOST' END,finished_at=now() WHERE (status='queued' AND deadline<now()) OR (status='running' AND (lease_until<now() OR deadline<now())) RETURNING id,error_code",
      );
      for (const job of expiredJobs) {
        await tx.query("DELETE FROM knowledge_chunks WHERE job_id=$1", [job.id]);
        await tx.query(
          "UPDATE knowledge_documents SET status='failed',error_code=$1,chunk_count=0 WHERE job_id=$2 AND status IN ('queued','processing')",
          [job.error_code, job.id],
        );
      }
    });
  }
}
