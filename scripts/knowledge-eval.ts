import "./env.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "@platform/database";
import { Vault } from "../apps/control-plane/src/infrastructure/crypto.ts";
import { Knowledge } from "../apps/control-plane/src/modules/knowledge/knowledge.ts";
import { modelDto } from "../apps/control-plane/src/modules/resources/index.ts";
import { Platform } from "../apps/control-plane/src/platform.ts";
import { executeKnowledgeJob, retrieve } from "../apps/runtime/src/knowledge/knowledge.ts";
import {
  KnowledgeBatch,
  KnowledgeInput,
  KnowledgeSnapshot,
} from "../packages/contracts/src/index.ts";
import { required } from "./env.ts";
import {
  datasetDigest,
  EvaluationDataset,
  retryEvaluationRequest,
  scoreEvidence,
  summarizeEvidence,
} from "./knowledge-evaluation.ts";

const { values } = parseArgs({
  options: {
    "embedding-model": { type: "string" },
    "rerank-model": { type: "string" },
    dataset: { type: "string", default: "docs/evaluations/enterprise-policy-v1.json" },
    out: { type: "string", default: ".scratch/knowledge-evaluation" },
  },
});
if (!values["embedding-model"])
  throw new Error(
    "Usage: pnpm knowledge:eval --embedding-model <existing model id> [--rerank-model <id>]",
  );
const dataset = EvaluationDataset.parse(JSON.parse(await readFile(values.dataset, "utf8")));
const ids = new Set(dataset.cases.map((c) => c.id));
if (ids.size !== dataset.cases.length) throw new Error("Duplicate case IDs");
for (const item of dataset.cases)
  for (const expected of item.expected) {
    const doc = dataset.documents.find((d) => d.filename === expected.filename);
    if (!doc?.content.includes(expected.contains))
      throw new Error(`Missing gold evidence: ${item.id}`);
  }
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const source = new Database(required("DATABASE_URL")),
  vault = new Vault(required("ENCRYPTION_KEY"));
const schema = `test_knowledge_eval_${process.pid}_${Date.now()}`;
let db: Database | undefined;
try {
  const readModel = async (id: string) => {
    const [r] = await source.query("SELECT * FROM resources WHERE id=$1 AND kind='model'", [id]);
    if (!r) throw new Error("Model not found");
    return { model: modelDto(r), apiKey: r.secret_enc ? vault.decrypt(String(r.secret_enc)) : "" };
  };
  const embedding = await readModel(values["embedding-model"]),
    rerank = values["rerank-model"] ? await readModel(values["rerank-model"]) : null;
  if (embedding.model.kind !== "embedding" || (rerank && rerank.model.kind !== "rerank"))
    throw new Error("Wrong model kind");
  await source.query(`CREATE SCHEMA ${schema}`);
  db = new Database(required("DATABASE_URL"), schema);
  const platform = new Platform(db, vault),
    knowledge = new Knowledge(platform);
  await platform.initialize();
  const password = `eval-${crypto.randomUUID()}`;
  await platform.identity.setup("evaluation", password, "Synthetic evaluation");
  const actor = await platform.identity.session(
    await platform.identity.login("evaluation", password),
  );
  const project = await platform.projects.create(actor, {
    name: "Synthetic policy evaluation",
    description: "Disposable evaluation schema",
  });
  const copy = async (value: typeof embedding) =>
    platform.resources.createModel(actor, project.id, {
      name: value.model.name,
      kind: value.model.kind,
      modelId: value.model.modelId,
      baseUrl: value.model.baseUrl,
      dimensions: value.model.dimensions ?? undefined,
      apiKey: value.apiKey,
    });
  const em = await copy(embedding),
    rm = rerank ? await copy(rerank) : null,
    keys = { [em.id]: embedding.apiKey, ...(rm && rerank ? { [rm.id]: rerank.apiKey } : {}) };
  const corpora = [];
  for (const mode of ["plain-recursive", "source-structured"]) {
    const kb = await knowledge.create(
      actor,
      project.id,
      KnowledgeInput.parse({
        name: mode,
        embeddingModelId: em.id,
        chunkSize: 800,
        chunkOverlap: 80,
      }),
    );
    for (const file of dataset.documents) {
      if (mode === "plain-recursive") await knowledge.upload(actor, project.id, kb.id, file);
      else {
        const preview = await knowledge.previewDocument(actor, project.id, kb.id, {
          filename: file.filename,
          fileBase64: Buffer.from(file.content).toString("base64"),
        });
        await knowledge.importDocument(actor, project.id, kb.id, preview.id);
      }
      const job = await knowledge.claim();
      if (!job) throw new Error("Missing ingest job");
      const result = await executeKnowledgeJob(
        job,
        AbortSignal.timeout(240000),
        async (_path, body) => {
          await knowledge.batch(job.id, KnowledgeBatch.parse(body));
          return {};
        },
      );
      await knowledge.finish(job.id, result);
    }
    corpora.push({ mode, kb });
    console.log(`Indexed ${mode}: ${dataset.documents.length} documents`);
  }
  const variants = [
    { name: "当前纯文本分段 + 向量检索", corpus: corpora[0], rerank: false },
    { name: "来源结构分段 + 向量检索", corpus: corpora[1], rerank: false },
    ...(rm ? [{ name: "来源结构分段 + 向量检索 + 重排", corpus: corpora[1], rerank: true }] : []),
  ];
  const results = [];
  for (const variant of variants) {
    const base = await platform.resources.knowledgeSnapshot(
      actor,
      project.id,
      variant.corpus.kb.id,
    );
    const snapshot = KnowledgeSnapshot.parse({ ...base, rerankModel: variant.rerank ? rm : null });
    const rows = [];
    for (const item of dataset.cases) {
      const start = performance.now();
      let response: { value: Awaited<ReturnType<typeof retrieve>>; attempts: number };
      try {
        response = await retryEvaluationRequest(() =>
          retrieve(snapshot, keys, item.query, 5, AbortSignal.timeout(120000), async (vector) => ({
            hits: await knowledge.nearest(db as Database, variant.corpus.kb.id, vector),
          })),
        );
      } catch (error) {
        await writeFile(
          resolve(out, "failure.json"),
          JSON.stringify(
            {
              datasetDigest: datasetDigest(dataset),
              variant: variant.name,
              caseId: item.id,
              completed: rows.length,
              error: error instanceof Error ? error.name : "UnknownError",
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        throw new Error(
          `Evaluation interrupted at ${variant.name} / ${item.id}; completed rows saved.`,
          { cause: error },
        );
      }
      const hits = response.value;
      rows.push({
        ...scoreEvidence(item, hits),
        durationMs: Math.round(performance.now() - start),
        hits,
        attempts: response.attempts,
      });
      await writeFile(
        resolve(out, "results.partial.json"),
        JSON.stringify(
          {
            datasetDigest: datasetDigest(dataset),
            models: { embedding: embedding.model.modelId, rerank: rerank?.model.modelId ?? null },
            completedVariants: results,
            current: { name: variant.name, rows },
          },
          null,
          2,
        ),
      );
      if (rows.length % 10 === 0)
        console.log(`${variant.name}: ${rows.length}/${dataset.cases.length}`);
    }
    const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    results.push({
      name: variant.name,
      summary: summarizeEvidence(rows),
      p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
      rows,
    });
  }
  const report = {
    dataset: {
      name: dataset.name,
      version: dataset.version,
      digest: datasetDigest(dataset),
      synthetic: dataset.synthetic,
    },
    createdAt: new Date().toISOString(),
    models: { embedding: embedding.model.modelId, rerank: rerank?.model.modelId ?? null },
    topK: 5,
    results,
  };
  await writeFile(resolve(out, "results.json"), JSON.stringify(report, null, 2));
  const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
  const markdown = `# 企业制度知识库检索评测\n\n${dataset.description}\n\n数据集：${dataset.name} ${dataset.version}；SHA-256：${report.dataset.digest}。\n\n向量模型：${report.models.embedding}；重排模型：${report.models.rerank ?? "未配置"}；topK=5。\n\n| 配置 | 全部必要依据命中 | 依据召回率 | MRR | 无答案问题仍返回片段 | P95 耗时 |\n|---|---:|---:|---:|---:|---:|\n${results.map((r) => `| ${r.name} | ${pct(r.summary.completeEvidenceRate)} | ${pct(r.summary.meanEvidenceRecall)} | ${r.summary.meanReciprocalRank?.toFixed(3)} | ${pct(r.summary.unanswerableCandidateRate)} | ${r.p95Ms} ms |`).join("\n")}\n\n完整依据命中按文档名与预设证据文本联合判断，跨文档问题须全部命中。无答案指标仅说明检索仍返回候选，不等同于模型幻觉率。本轮未生成最终回答，未测回答忠实度；模型接口未提供可用的费用核算，此报告不估算成本。\n\n## 未完整命中的问题\n\n${results
    .map(
      (r) =>
        `### ${r.name}\n\n${
          r.rows
            .filter((q) => q.answerable && !q.completeEvidence)
            .map(
              (q) => `- ${q.id}：${q.query}（缺少 ${q.missing.map((m) => m.filename).join("、")}）`,
            )
            .join("\n") || "全部命中预设依据。"
        }`,
    )
    .join("\n\n")}\n`;
  await writeFile(resolve(out, "report.md"), markdown);
  console.log(`Report: ${resolve(out, "report.md")}`);
} finally {
  await db?.close();
  if (db) await source.query(`DROP SCHEMA ${schema} CASCADE`);
  await source.close();
}
