import { randomUUID } from "node:crypto";
import {
  agentWorkflowInput,
  agentWorkflowOutput,
  assertWorkflowValue,
  canonicalJson,
  Model,
  type Principal,
  Release,
  Tool,
  validateWorkflow,
  WorkflowAsset,
  WorkflowAssetInput,
  type WorkflowCapability,
  WorkflowGeneration,
  type WorkflowGenerationInput,
  WorkflowRelease,
  WorkflowRun,
  type WorkflowRunInput,
  WorkflowSnapshot,
  workflowExecutionDefinition,
  type z,
} from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import type { ExecutionContext } from "../../infrastructure/execution-context.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import type { Agents } from "../agents/index.ts";
import type { Projects } from "../projects/index.ts";
import { requireUser } from "../projects/index.ts";
import { modelDto, type Resources } from "../resources/index.ts";

export const workflowDate = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
export const workflowTool = (r: Row) =>
  Tool.parse({
    ...(r.data as object),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    createdAt: workflowDate(r.created_at),
    version: 1,
  });
export const workflowAgentRelease = (r: Row) =>
  Release.parse({
    id: r.id,
    agentId: r.agent_id,
    projectId: r.project_id,
    version: r.version,
    digest: r.digest,
    snapshot: r.snapshot,
    createdAt: workflowDate(r.created_at),
  });
const releaseDto = (r: Row) =>
  WorkflowRelease.parse({
    id: r.id,
    workflowId: r.workflow_id,
    projectId: r.project_id,
    name: r.name,
    version: r.version,
    digest: r.digest,
    snapshot: r.snapshot,
    createdAt: workflowDate(r.created_at),
  });
const assetDto = (row: Row) =>
  WorkflowAsset.parse({
    ...(row.data as object),
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    publishedReleaseId: row.current_release_id,
    publishedVersion: row.version ?? null,
    createdAt: workflowDate(row.created_at),
  });
const runDto = (r: Row) =>
  WorkflowRun.parse({
    id: r.id,
    workflowId: r.workflow_id,
    releaseId: r.release_id,
    version: r.version,
    name: r.name,
    status: r.status,
    input: r.input,
    output: r.output,
    errorCode: r.error_code,
    createdAt: workflowDate(r.created_at),
    finishedAt: r.finished_at ? workflowDate(r.finished_at) : null,
  });
const generationDto = (r: Row) => {
  const input = r.input as z.infer<typeof WorkflowGenerationInput>;
  return WorkflowGeneration.parse({
    id: r.id,
    workflowId: r.workflow_id,
    baseRevision: input.baseRevision,
    intent: input.intent,
    modelId: input.modelId,
    status: r.status,
    candidate: r.candidate,
    issues: r.issues,
    attempts: r.attempts,
    acceptedRevision: r.accepted_revision,
    errorCode: r.error_code,
    createdAt: workflowDate(r.created_at),
    finishedAt: r.finished_at ? workflowDate(r.finished_at) : null,
  });
};
export function toolCapability(tool: z.infer<typeof Tool>): WorkflowCapability {
  const outputSchema =
    tool.kind === "mcp" && tool.mcp?.descriptor.outputSchema
      ? {
          type: "object",
          properties: { text: { type: "string" }, data: tool.mcp.descriptor.outputSchema },
          required: ["text", "data"],
          additionalProperties: false,
        }
      : tool.outputSchema;
  return {
    kind: "tool",
    id: tool.id,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    inputSchema: tool.inputSchema,
    outputSchema,
  };
}
const agentCapability = (release: z.infer<typeof Release>): WorkflowCapability => ({
  kind: "agent",
  id: release.id,
  name: release.snapshot.agent.name,
  description: release.snapshot.agent.description,
  version: release.version,
  inputSchema: agentWorkflowInput,
  outputSchema: agentWorkflowOutput,
});
export class Workflows {
  constructor(
    readonly deps: ExecutionContext & { projects: Projects; resources: Resources; agents: Agents },
  ) {}
  get db() {
    return this.deps.db;
  }
  async asset(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.deps.projects.get(actor, projectId, tx);
    const [row] = await tx.query(
      `SELECT w.*,r.version FROM workflows w LEFT JOIN workflow_releases r ON r.id=w.current_release_id WHERE w.id=$1 AND w.project_id=$2 AND w.tenant_id=$3 ${lock ? "FOR UPDATE OF w" : ""}`,
      [id, projectId, actor.tenantId],
    );
    if (!row) throw notFound();
    return assetDto(row);
  }
  async list(actor: Principal, projectId: string, input: PageInput = {}) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    const page = cursorPage(["workflows", actor.tenantId, projectId], input);
    const rows = await this.db.query(
      `SELECT w.*,r.version,${page.select("w")} FROM workflows w
       LEFT JOIN workflow_releases r ON r.id=w.current_release_id
       WHERE w.project_id=$1 AND w.tenant_id=$2 AND ${page.where("w", 3)}
       ORDER BY w.created_at DESC,w.id DESC LIMIT $5`,
      [projectId, actor.tenantId, ...page.values],
    );
    return page.result(rows, assetDto);
  }
  private checkLayout(input: z.infer<typeof WorkflowAssetInput>) {
    if (
      JSON.stringify(input).length > 100000 ||
      Object.keys(input.layout).some((id) => !input.definition.nodes.some((n) => n.id === id))
    )
      throw new ApiError(400, "WORKFLOW_LAYOUT", "布局必须引用当前节点，草稿不能超过大小限制");
  }
  async create(actor: Principal, projectId: string, input: z.infer<typeof WorkflowAssetInput>) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    this.checkLayout(input);
    const id = randomUUID();
    await this.db.query("INSERT INTO workflows(id,tenant_id,project_id,data) VALUES($1,$2,$3,$4)", [
      id,
      actor.tenantId,
      projectId,
      input,
    ]);
    return this.asset(actor, projectId, id);
  }
  async update(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof WorkflowAssetInput>,
    baseRevision: number,
  ) {
    requireUser(actor);
    await this.asset(actor, projectId, id);
    this.checkLayout(input);
    const rows = await this.db.query(
      "UPDATE workflows SET data=$1,revision=revision+1 WHERE id=$2 AND project_id=$3 AND revision=$4 RETURNING id",
      [input, id, projectId, baseRevision],
    );
    if (!rows.length)
      throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请保留当前编辑并重新加载");
    return this.asset(actor, projectId, id);
  }
  async checkTool(tx: Queryable, projectId: string, tenantId: string, tool: z.infer<typeof Tool>) {
    if (tool.kind !== "mcp") return;
    const [server] = await tx.query(
      "SELECT s.enabled FROM mcp_servers s JOIN mcp_imports i ON i.server_id=s.id WHERE s.project_id=$1 AND s.tenant_id=$2 AND i.tool_id=$3 AND i.contract_digest=$4",
      [projectId, tenantId, tool.id, tool.mcp?.contractDigest],
    );
    if (!server?.enabled)
      throw new ApiError(409, "DEPENDENCY_UNAVAILABLE", "流程引用的 MCP 服务已停用或绑定失效");
  }
  async catalog(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    const tools = (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='tool' ORDER BY created_at DESC LIMIT 100",
        [projectId],
      )
    ).map(workflowTool);
    const entries: WorkflowCapability[] = [];
    for (const tool of tools) {
      try {
        await this.checkTool(this.db, projectId, actor.tenantId, tool);
        entries.push(toolCapability(tool));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "DEPENDENCY_UNAVAILABLE")) throw e;
      }
    }
    const releases = (
      await this.db.query(
        "SELECT * FROM releases WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",
        [projectId],
      )
    ).map(workflowAgentRelease);
    for (const release of releases) {
      try {
        await this.deps.agents.validate(actor, projectId, release.snapshot.agent);
        entries.push(agentCapability(release));
      } catch (e) {
        if (!(e instanceof ApiError && ["MCP_DISABLED", "DEPENDENCY_UNAVAILABLE"].includes(e.code)))
          throw e;
      }
    }
    return entries;
  }
  async snapshot(
    actor: Principal,
    projectId: string,
    definition: WorkflowSnapshot["definition"],
    tx: Queryable = this.db,
  ) {
    const tools: z.infer<typeof Tool>[] = [],
      agents: z.infer<typeof Release>[] = [];
    for (const node of definition.nodes) {
      if (node.type === "tool" && !tools.some((t) => t.id === node.toolId)) {
        const tool = workflowTool(
          await this.deps.resources.get(actor, projectId, node.toolId, "tool", tx),
        );
        await this.checkTool(tx, projectId, actor.tenantId, tool);
        tools.push(tool);
      }
      if (node.type === "agent" && !agents.some((a) => a.id === node.releaseId)) {
        const [row] = await tx.query(
          "SELECT * FROM releases WHERE id=$1 AND project_id=$2 AND tenant_id=$3",
          [node.releaseId, projectId, actor.tenantId],
        );
        if (!row) throw notFound();
        const release = workflowAgentRelease(row);
        await this.deps.agents.validate(actor, projectId, release.snapshot.agent, tx);
        agents.push(release);
      }
    }
    tools.sort((a, b) => a.id.localeCompare(b.id));
    agents.sort((a, b) => a.id.localeCompare(b.id));
    return WorkflowSnapshot.parse({
      definition,
      tools,
      agents,
      catalog: [...tools.map(toolCapability), ...agents.map(agentCapability)],
      adapterVersion: "mastra-workflow-v1",
    });
  }
  async validate(actor: Principal, projectId: string, id: string, baseRevision: number) {
    requireUser(actor);
    const asset = await this.asset(actor, projectId, id);
    if (asset.revision !== baseRevision)
      throw new ApiError(409, "DRAFT_CONFLICT", "请校验最新草稿");
    const snapshot = await this.snapshot(actor, projectId, asset.definition);
    return { issues: validateWorkflow(snapshot.definition, snapshot.catalog) };
  }
  async publish(actor: Principal, projectId: string, id: string, baseRevision: number) {
    requireUser(actor);
    return this.db.transaction(async (tx) => {
      const asset = await this.asset(actor, projectId, id, tx, true);
      if (asset.revision !== baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请重新发布");
      const snapshot = await this.snapshot(actor, projectId, asset.definition, tx);
      const issues = validateWorkflow(snapshot.definition, snapshot.catalog);
      if (issues.length) throw new ApiError(400, "WORKFLOW_INVALID", issues[0].message);
      const digest = sha256(
        canonicalJson({
          ...snapshot,
          definition: workflowExecutionDefinition(snapshot.definition),
        }),
      );
      const [latest] = await tx.query(
        "SELECT * FROM workflow_releases WHERE workflow_id=$1 ORDER BY version DESC LIMIT 1",
        [id],
      );
      if (latest?.digest === digest) return releaseDto(latest);
      const [row] = await tx.query(
        "INSERT INTO workflow_releases(id,tenant_id,project_id,workflow_id,name,version,digest,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          randomUUID(),
          actor.tenantId,
          projectId,
          id,
          asset.name,
          Number(latest?.version ?? 0) + 1,
          digest,
          snapshot,
        ],
      );
      await tx.query("UPDATE workflows SET current_release_id=$1 WHERE id=$2", [row.id, id]);
      return releaseDto(row);
    });
  }
  async releases(actor: Principal, projectId: string, id: string, input: PageInput = {}) {
    requireUser(actor);
    await this.asset(actor, projectId, id);
    const page = cursorPage(
      ["workflow-releases", actor.tenantId, projectId, id],
      input,
      100,
      "version",
    );
    const rows = await this.db.query(
      `SELECT r.*,${page.select("r")} FROM workflow_releases r
       WHERE r.workflow_id=$1 AND r.project_id=$2 AND ${page.where("r", 3)}
       ORDER BY r.version DESC,r.id DESC LIMIT $5`,
      [id, projectId, ...page.values],
    );
    return page.result(rows, releaseDto);
  }
  async ownedJob(
    actor: Principal,
    projectId: string,
    id: string,
    kind: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.deps.projects.get(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT * FROM workflow_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND entry=$4 AND kind=$5 ${lock ? "FOR UPDATE" : ""}`,
      [id, projectId, actor.id, actor.entry, kind],
    );
    if (!r) throw notFound();
    return r;
  }
  async run(actor: Principal, projectId: string, id: string) {
    const r = await this.ownedJob(actor, projectId, id, "execute");
    const [release] = await this.db.query(
      "SELECT version,name FROM workflow_releases WHERE id=$1",
      [r.release_id],
    );
    return runDto({ ...r, ...release });
  }
  async runs(actor: Principal, projectId: string, workflowId: string, input: PageInput = {}) {
    await this.asset(actor, projectId, workflowId);
    const page = cursorPage(
      ["workflow-runs", actor.tenantId, projectId, workflowId, actor.id, actor.entry],
      input,
    );
    const rows = await this.db.query(
      `SELECT j.*,r.version,r.name,${page.select("j")} FROM workflow_jobs j
       JOIN workflow_releases r ON r.id=j.release_id
       WHERE j.workflow_id=$1 AND j.project_id=$2 AND j.actor_id=$3 AND j.entry=$4 AND j.kind='execute'
       AND ${page.where("j", 5)} ORDER BY j.created_at DESC,j.id DESC LIMIT $7`,
      [workflowId, projectId, actor.id, actor.entry, ...page.values],
    );
    return page.result(rows, runDto);
  }

  async enqueue(
    actor: Principal,
    projectId: string,
    workflowId: string,
    kind: "execute" | "generate",
    requestId: string,
    request: unknown,
    input: unknown,
    snapshot: unknown,
    releaseId: string | null,
    tx: Queryable,
  ) {
    const hash = sha256(canonicalJson(request));
    const [prior] = await tx.query(
      "SELECT id,request_hash FROM workflow_jobs WHERE workflow_id=$1 AND actor_id=$2 AND entry=$3 AND kind=$4 AND request_id=$5",
      [workflowId, actor.id, actor.entry, kind, requestId],
    );
    if (prior) {
      if (prior.request_hash !== hash)
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容");
      return String(prior.id);
    }
    const [count] = await tx.query(
      "SELECT count(*)::int AS n FROM workflow_jobs WHERE project_id=$1 AND status IN ('queued','running')",
      [projectId],
    );
    if (Number(count.n) >= 20)
      throw new ApiError(429, "WORKFLOW_BUSY", "项目待执行任务已达上限，请稍后重试");
    const id = randomUUID();
    await tx.query(
      "INSERT INTO workflow_jobs(id,workflow_id,tenant_id,project_id,actor_id,entry,kind,release_id,snapshot,input,request_id,request_hash,status,runtime_id,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',$13,clock_timestamp()+interval '5 minutes')",
      [
        id,
        workflowId,
        actor.tenantId,
        projectId,
        actor.id,
        actor.entry,
        kind,
        releaseId,
        snapshot,
        input,
        requestId,
        hash,
        this.deps.runtimeId,
      ],
    );
    return id;
  }
  async createRun(
    actor: Principal,
    projectId: string,
    workflowId: string,
    input: z.infer<typeof WorkflowRunInput>,
  ) {
    const id = await this.db.transaction(async (tx) => {
      await this.asset(actor, projectId, workflowId, tx, true);
      const [release] = await tx.query(
        "SELECT * FROM workflow_releases WHERE id=$1 AND workflow_id=$2 AND project_id=$3",
        [input.releaseId, workflowId, projectId],
      );
      if (!release) throw notFound();
      const snapshot = WorkflowSnapshot.parse(release.snapshot);
      try {
        assertWorkflowValue(snapshot.definition.inputSchema, input.input);
      } catch {
        throw new ApiError(400, "WORKFLOW_INPUT", "运行输入不符合发布的 Schema");
      }
      await this.snapshot(actor, projectId, snapshot.definition, tx);
      return this.enqueue(
        actor,
        projectId,
        workflowId,
        "execute",
        input.requestId,
        input,
        input.input,
        snapshot,
        String(release.id),
        tx,
      );
    });
    return this.run(actor, projectId, id);
  }
  async generation(actor: Principal, projectId: string, id: string) {
    requireUser(actor);
    const r = await this.ownedJob(actor, projectId, id, "generate");
    return generationDto(r);
  }
  async generations(
    actor: Principal,
    projectId: string,
    workflowId: string,
    input: PageInput = {},
  ) {
    requireUser(actor);
    await this.asset(actor, projectId, workflowId);
    const page = cursorPage(
      ["workflow-generations", actor.tenantId, projectId, workflowId, actor.id, actor.entry],
      input,
      20,
    );
    const rows = await this.db.query(
      `SELECT j.*,${page.select("j")} FROM workflow_jobs j
       WHERE j.workflow_id=$1 AND j.project_id=$2 AND j.actor_id=$3 AND j.entry=$4 AND j.kind='generate'
       AND ${page.where("j", 5)} ORDER BY j.created_at DESC,j.id DESC LIMIT $7`,
      [workflowId, projectId, actor.id, actor.entry, ...page.values],
    );
    return page.result(rows, generationDto);
  }
  async generate(
    actor: Principal,
    projectId: string,
    workflowId: string,
    input: z.infer<typeof WorkflowGenerationInput>,
  ) {
    requireUser(actor);
    const catalog = await this.catalog(actor, projectId);
    if (JSON.stringify(catalog).length > 160000)
      throw new ApiError(
        400,
        "CATALOG_LIMIT",
        "当前项目的能力目录超过编排上下文限制，请减少资源或缩短接口说明",
      );
    const id = await this.db.transaction(async (tx) => {
      const asset = await this.asset(actor, projectId, workflowId, tx, true);
      if (asset.revision !== input.baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "请基于最新草稿生成候选");
      const model = Model.parse(
        modelDto(await this.deps.resources.get(actor, projectId, input.modelId, "model", tx)),
      );
      if (model.kind !== "chat") throw new ApiError(400, "MODEL_KIND", "编排需要对话模型");
      return this.enqueue(
        actor,
        projectId,
        workflowId,
        "generate",
        input.requestId,
        input,
        input,
        { definition: asset.definition, catalog, model },
        null,
        tx,
      );
    });
    return this.generation(actor, projectId, id);
  }
  async accept(actor: Principal, projectId: string, id: string, baseRevision: number) {
    requireUser(actor);
    return this.db.transaction(async (tx) => {
      // Use the same asset-before-job order as enqueue and publishing.
      const initial = await this.ownedJob(actor, projectId, id, "generate", tx);
      const asset = await this.asset(actor, projectId, String(initial.workflow_id), tx, true);
      const job = await this.ownedJob(actor, projectId, id, "generate", tx, true);
      if (job.accepted_revision) return asset;
      if (job.status !== "succeeded" || !job.candidate || (job.issues as unknown[]).length)
        throw new ApiError(409, "CANDIDATE_INVALID", "候选尚未通过校验");
      if (
        asset.revision !== baseRevision ||
        (job.input as { baseRevision: number }).baseRevision !== baseRevision
      )
        throw new ApiError(
          409,
          "DRAFT_CONFLICT",
          "生成期间草稿已变化；保留候选，请基于最新草稿重新生成",
        );
      const candidate = job.candidate as { definition: WorkflowSnapshot["definition"] };
      const snapshot = await this.snapshot(actor, projectId, candidate.definition, tx);
      if (validateWorkflow(snapshot.definition, snapshot.catalog).length)
        throw new ApiError(409, "CANDIDATE_INVALID", "候选的当前依赖或变量校验未通过");
      const data = WorkflowAssetInput.parse({
        name: asset.name,
        description: asset.description,
        definition: candidate.definition,
        // A generated graph receives a fresh FlowGram layout after node measurement.
        layout: {},
      });
      await tx.query("UPDATE workflows SET data=$1,revision=revision+1 WHERE id=$2", [
        data,
        asset.id,
      ]);
      await tx.query("UPDATE workflow_jobs SET accepted_revision=$1 WHERE id=$2", [
        asset.revision + 1,
        id,
      ]);
      return this.asset(actor, projectId, asset.id, tx);
    });
  }
}
