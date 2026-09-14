import { randomUUID } from "node:crypto";
import {
  KnowledgeSnapshot,
  Model,
  type ModelDiscoverInput,
  type ModelInput,
  type ModelProbeInput,
  type ModelUpdate,
  type Principal,
  Tool,
  type ToolInput,
  type ToolProbeInput,
  type ToolUpdate,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { Ajv } from "ajv";
import type { Vault } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { data, date } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";
import { discoverModelsRequest } from "./discovery.ts";
import { probeModelRequest } from "./probe.ts";
import { probeToolRequest } from "./tool-probe.ts";
import { modelVendorPresets } from "./vendors.ts";
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
    await this.projects.access.require(actor, projectId, "resource.read");
    requireUser(actor);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='model' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(modelDto);
  }
  async createModel(actor: Principal, projectId: string, input: ModelInput) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    checkUrl(input.baseUrl);
    checkDimensions(input);
    const { apiKey, ...payload } = input,
      id = randomUUID();
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data,secret_enc) VALUES($1,$2,$3,'model',$4,$5) RETURNING *",
      [id, actor.tenantId, projectId, payload, this.vault.encrypt(apiKey ?? "")],
    );
    return modelDto(r);
  }
  /**
   * Editing a model changes what future publishes use. Releases already published
   * embed their own snapshot, so they keep calling the configuration they were
   * published with. An omitted or empty `apiKey` keeps the stored credential.
   */
  async updateModel(actor: Principal, projectId: string, id: string, input: ModelUpdate) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    checkUrl(input.baseUrl);
    checkDimensions(input);
    return this.db.transaction(async (tx) => {
      const existing = await this.get(actor, projectId, id, "model", tx, true);
      const { apiKey, ...payload } = input;
      const [r] = await tx.query(
        "UPDATE resources SET data=$1, secret_enc=$2 WHERE id=$3 RETURNING *",
        [payload, apiKey ? this.vault.encrypt(apiKey) : String(existing.secret_enc ?? ""), id],
      );
      return modelDto(r);
    });
  }
  /**
   * Probes the service from the control plane, using the request the Runtime would
   * make. A saved credential can be reused by id, but only from this project.
   */
  async probeModel(actor: Principal, projectId: string, input: ModelProbeInput) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    checkUrl(input.baseUrl);
    checkDimensions(input);
    const key = await this.resolveKey(
      actor,
      projectId,
      "model",
      input.apiKey,
      input.credentialFrom,
    );
    return probeModelRequest(input, key);
  }
  /**
   * Lists the model ids a service advertises, so the console can offer them for
   * selection. Uses the same credential resolution as probing.
   */
  async discoverModels(actor: Principal, projectId: string, input: ModelDiscoverInput) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    checkUrl(input.baseUrl);
    const key = await this.resolveKey(
      actor,
      projectId,
      "model",
      input.apiKey,
      input.credentialFrom,
    );
    return discoverModelsRequest(input, key);
  }
  /**
   * The vendor catalogue the console offers; static, so it needs no project scope.
   * Management-only, matching the rest of the resource directory: application
   * credentials exist to call a published Agent, not to browse configuration.
   */
  vendors(actor: Principal) {
    requireUser(actor);
    return modelVendorPresets();
  }
  /**
   * A supplied secret wins; otherwise the saved credential of `credentialFrom` is
   * decrypted, but only when that resource belongs to this project. Models and
   * tools share this, so a tool token can never be resolved through the model
   * path or the other way round.
   */
  private async resolveKey(
    actor: Principal,
    projectId: string,
    kind: "model" | "tool",
    supplied: string | undefined,
    credentialFrom: string | undefined,
  ) {
    if (supplied) return supplied;
    if (!credentialFrom) return "";
    const [row] = await this.db.query(
      "SELECT secret_enc FROM resources WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND kind=$4",
      [credentialFrom, projectId, actor.tenantId, kind],
    );
    if (!row) throw notFound();
    return this.vault.decrypt(String(row.secret_enc ?? ""));
  }
  async tools(actor: Principal, projectId: string) {
    await this.projects.access.require(actor, projectId, "resource.read");
    requireUser(actor);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='tool' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(toolDto);
  }
  async createTool(actor: Principal, projectId: string, request: ToolInput) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    const input = authoredTool(request);
    const { bearerToken, ...payload } = input,
      id = randomUUID();
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data,secret_enc) VALUES($1,$2,$3,'tool',$4,$5) RETURNING *",
      [id, actor.tenantId, projectId, payload, this.vault.encrypt(bearerToken)],
    );
    return toolDto(r);
  }
  /**
   * Editing a tool changes what future publishes use. Releases already published
   * embed their own snapshot, so they keep calling the configuration they were
   * published with. An omitted or empty `bearerToken` keeps the stored token.
   *
   * An MCP tool is refused: it is a pinned projection of a remote descriptor
   * produced by the import flow, so editing it here would silently disagree with
   * the descriptor it claims to be.
   */
  async updateTool(actor: Principal, projectId: string, id: string, request: ToolUpdate) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    const existing = toolDto(await this.get(actor, projectId, id, "tool"));
    if (existing.kind === "mcp")
      throw new ApiError(
        409,
        "MCP_TOOL_IMMUTABLE",
        "MCP 工具由服务导入生成，请在 MCP 服务中重新导入",
      );
    const input = authoredTool(request);
    return this.db.transaction(async (tx) => {
      const current = await this.get(actor, projectId, id, "tool", tx, true);
      const { bearerToken, ...payload } = input;
      const [r] = await tx.query(
        "UPDATE resources SET data=$1, secret_enc=$2 WHERE id=$3 RETURNING *",
        [
          payload,
          bearerToken ? this.vault.encrypt(bearerToken) : String(current.secret_enc ?? ""),
          id,
        ],
      );
      return toolDto(r);
    });
  }
  /**
   * Calls the tool from the control plane exactly the way the Runtime would, with
   * the Runtime's own timeout, so an operator learns whether the configuration
   * works before an Agent depends on it. A saved token can be reused by id, but
   * only from this project. MCP tools are refused: calling one needs a live
   * binding that only the Runtime holds.
   */
  async probeTool(actor: Principal, projectId: string, input: ToolProbeInput) {
    await this.projects.access.require(actor, projectId, "resource.manage");
    requireUser(actor);
    if (input.kind === "http_get" && input.url) checkUrl(input.url);
    const token = await this.resolveKey(
      actor,
      projectId,
      "tool",
      input.bearerToken,
      input.credentialFrom,
    );
    return probeToolRequest(input, token);
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
function checkDimensions(input: { kind?: string; dimensions?: number }) {
  if (input.dimensions !== undefined && input.kind !== "embedding")
    throw new ApiError(400, "MODEL_DIMENSIONS", "仅向量模型可以配置维度");
}
/** The fixed contract the Runtime evaluates for `sum`; an operator never supplies it. */
const sumSchemas = {
  inputSchema: {
    type: "object",
    properties: {
      values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 100 },
    },
    required: ["values"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
    additionalProperties: false,
  },
};
/**
 * Normalises a hand-authored tool and rejects a payload the Runtime could never
 * execute. Both create and update go through here so a stored tool cannot be
 * made invalid by editing it after registration.
 */
function authoredTool<T extends ToolInput | ToolUpdate>(request: T) {
  const input = { ...request };
  if (input.kind === "http_get") checkUrl(input.url);
  if (input.kind === "sum") Object.assign(input, sumSchemas);
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
  return input;
}
/** Instance metadata endpoints must never become a model target. */
const metadataHosts = new Set(["169.254.169.254", "metadata.google.internal", "fd00:ec2::254"]);
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
  if (metadataHosts.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase()))
    throw new ApiError(400, "INVALID_ENDPOINT", "服务地址不能指向云实例元数据地址");
}
