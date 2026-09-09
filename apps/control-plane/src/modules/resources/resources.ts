import { randomUUID } from "node:crypto";
import {
  KnowledgeSnapshot,
  Model,
  type ModelInput,
  type Principal,
  Tool,
  type ToolInput,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { Ajv } from "ajv";
import type { Vault } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { data, date } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";
export const modelDto = (r: Row) =>
  Model.parse({
    ...data(r),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    createdAt: date(r.created_at),
    provider: "openai-compatible",
  });
export const toolDto = (r: Row) =>
  Tool.parse({
    ...data(r),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    createdAt: date(r.created_at),
    version: 1,
  });
export class Resources {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
    private readonly projects: Projects,
  ) {}
  async get(
    actor: Principal,
    projectId: string,
    id: string,
    kind: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.projects.get(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT * FROM resources WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND kind=$4 ${lock ? "FOR UPDATE" : ""}`,
      [id, projectId, actor.tenantId, kind],
    );
    if (!r) throw notFound();
    return r;
  }
  async models(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='model' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(modelDto);
  }
  async createModel(actor: Principal, projectId: string, input: ModelInput) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    checkUrl(input.baseUrl);
    if (input.dimensions !== undefined && input.kind !== "embedding")
      throw new ApiError(400, "MODEL_DIMENSIONS", "仅向量模型可以配置维度");
    const { apiKey, ...payload } = input,
      id = randomUUID();
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data,secret_enc) VALUES($1,$2,$3,'model',$4,$5) RETURNING *",
      [id, actor.tenantId, projectId, payload, this.vault.encrypt(apiKey ?? "")],
    );
    return modelDto(r);
  }
  async tools(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='tool' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(toolDto);
  }
  async createTool(actor: Principal, projectId: string, request: ToolInput) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    const input = { ...request };
    if (input.kind === "http_get") checkUrl(input.url);
    if (input.kind === "sum") {
      input.inputSchema = {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 100 },
        },
        required: ["values"],
        additionalProperties: false,
      };
      input.outputSchema = {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
        additionalProperties: false,
      };
    }
    try {
      const validator = new Ajv({ strict: false, addUsedSchema: false });
      if (input.inputSchema.type !== "object") throw new Error("Object input required");
      validator.compile(input.inputSchema);
      validator.compile(input.outputSchema);
    } catch {
      throw new ApiError(
        400,
        "INVALID_TOOL_SCHEMA",
        "工具输入必须为 object，输入与输出必须为有效的 JSON Schema",
      );
    }
    const { bearerToken, ...payload } = input,
      id = randomUUID();
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data,secret_enc) VALUES($1,$2,$3,'tool',$4,$5) RETURNING *",
      [id, actor.tenantId, projectId, payload, this.vault.encrypt(bearerToken)],
    );
    return toolDto(r);
  }
  async knowledgeSnapshot(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.db,
  ) {
    await this.projects.get(actor, projectId, tx);
    const [kb] = await tx.query("SELECT * FROM knowledge_bases WHERE id=$1 AND project_id=$2", [
      id,
      projectId,
    ]);
    if (!kb) throw notFound();
    const config = data(kb);
    return KnowledgeSnapshot.parse({
      id,
      name: config.name,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      embeddingModel: modelDto(
        await this.get(actor, projectId, String(config.embeddingModelId), "model", tx),
      ),
      rerankModel: config.rerankModelId
        ? modelDto(await this.get(actor, projectId, String(config.rerankModelId), "model", tx))
        : null,
    });
  }
}
function checkUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "INVALID_ENDPOINT", "请输入有效的 HTTP(S) 服务地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      400,
      "INVALID_ENDPOINT",
      "服务地址必须为 HTTP(S)，且不能包含凭据、查询参数或片段",
    );
}
