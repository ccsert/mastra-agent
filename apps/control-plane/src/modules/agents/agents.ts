import { randomUUID } from "node:crypto";
import { Agent, AgentInput, type Principal, Release, ReleaseSnapshot } from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError } from "../../infrastructure/errors.ts";
import { data, date } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";
import { modelDto, type Resources, toolDto } from "../resources/index.ts";

import type { Skills } from "../skills/index.ts";

const agentDto = (r: Row) =>
  Agent.parse({
    ...data(r),
    id: r.id,
    projectId: r.project_id,
    draftRevision: r.revision,
    publishedReleaseId: r.current_release_id,
    publishedVersion: r.published_version ?? null,
    createdAt: date(r.created_at),
  });
export const releaseDto = (r: Row) =>
  Release.parse({
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    version: r.version,
    digest: r.digest,
    snapshot: r.snapshot,
    createdAt: date(r.created_at),
  });
export class Agents {
  constructor(
    private readonly db: Database,
    private readonly projects: Projects,
    private readonly resources: Resources,
    private readonly skills: Skills,
  ) {}
  async list(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    return (
      await this.db.query(
        "SELECT a.*,r.version AS published_version FROM resources a LEFT JOIN releases r ON r.id=a.current_release_id WHERE a.project_id=$1 AND a.kind='agent' ORDER BY a.created_at DESC",
        [projectId],
      )
    ).map(agentDto);
  }
  async validate(actor: Principal, projectId: string, input: AgentInput, tx: Queryable = this.db) {
    const model = modelDto(await this.resources.get(actor, projectId, input.modelId, "model", tx));
    if (model.kind !== "chat") throw new ApiError(400, "MODEL_KIND", "Agent 必须绑定对话模型");
    if (new Set(input.toolIds).size !== input.toolIds.length)
      throw new ApiError(400, "DUPLICATE_TOOLS", "同一工具不能重复绑定");
    await this.skills.snapshots(
      tx,
      { tenantId: actor.tenantId, projectId },
      AgentInput.parse(input).skillBindings,
    );
    const names = new Set();
    const knowledgeIds = input.knowledgeBaseIds ?? [];
    if (new Set(knowledgeIds).size !== knowledgeIds.length)
      throw new ApiError(400, "DUPLICATE_KNOWLEDGE", "同一知识库不能重复绑定");
    for (const id of knowledgeIds) await this.resources.knowledgeSnapshot(actor, projectId, id, tx);
    for (const id of input.toolIds) {
      const tool = await this.resources.get(actor, projectId, id, "tool", tx);
      const definition = toolDto(tool);
      if (definition.kind === "mcp") {
        const [service] = await tx.query(
          "SELECT s.enabled FROM mcp_servers s JOIN mcp_imports i ON i.server_id=s.id WHERE i.tool_id=$1 AND s.project_id=$2",
          [id, projectId],
        );
        if (!service?.enabled)
          throw new ApiError(409, "MCP_DISABLED", "Agent 绑定的 MCP 服务已停用");
      }
      const name = data(tool).name;
      if (
        typeof name === "string" &&
        (name === "knowledge_search" ||
          ["run_skill_script", "skill", "skill_search", "skill_read"].includes(name) ||
          name.startsWith("mastra_"))
      )
        throw new ApiError(400, "RESERVED_TOOL_NAME", "该工具名由平台保留");
      if (names.has(name)) throw new ApiError(400, "DUPLICATE_TOOL_NAMES", "工具名称不能重复");
      names.add(name);
    }
  }
  async create(actor: Principal, projectId: string, input: AgentInput) {
    requireUser(actor);
    await this.validate(actor, projectId, input);
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'agent',$4) RETURNING *",
      [randomUUID(), actor.tenantId, projectId, input],
    );
    return agentDto(r);
  }
  async update(
    actor: Principal,
    projectId: string,
    id: string,
    input: AgentInput,
    baseRevision: number,
  ) {
    requireUser(actor);
    await this.resources.get(actor, projectId, id, "agent");
    await this.validate(actor, projectId, input);
    const [r] = await this.db.query(
      "UPDATE resources SET data=$1,revision=revision+1 WHERE id=$2 AND project_id=$3 AND revision=$4 RETURNING *",
      [input, id, projectId, baseRevision],
    );
    if (!r) throw new ApiError(409, "DRAFT_CONFLICT", "草稿已被修改，请刷新后重试");
    return agentDto(r);
  }
  async publish(actor: Principal, projectId: string, id: string, baseRevision: number) {
    requireUser(actor);
    return this.db.transaction(async (tx) => {
      const resource = await this.resources.get(actor, projectId, id, "agent", tx, true);
      if (resource.revision !== baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请刷新后发布");
      const agent = AgentInput.parse(resource.data);
      await this.validate(actor, projectId, agent, tx);
      const model = modelDto(
          await this.resources.get(actor, projectId, agent.modelId, "model", tx),
        ),
        tools = [];
      for (const toolId of agent.toolIds)
        tools.push(toolDto(await this.resources.get(actor, projectId, toolId, "tool", tx)));
      const knowledgeBases = [];
      for (const kbId of agent.knowledgeBaseIds)
        knowledgeBases.push(await this.resources.knowledgeSnapshot(actor, projectId, kbId, tx));
      const snapshot = ReleaseSnapshot.parse({
        agent,
        model,
        tools,
        knowledgeBases,
        skills: await this.skills.snapshots(
          tx,
          { tenantId: actor.tenantId, projectId },
          agent.skillBindings,
        ),
        adapterVersion: "mastra-agent-v1",
      });
      const digest = sha256(JSON.stringify(snapshot));
      const [latest] = await tx.query(
        "SELECT * FROM releases WHERE agent_id=$1 ORDER BY version DESC LIMIT 1",
        [id],
      );
      if (latest?.digest === digest) return releaseDto(latest);
      const releaseId = randomUUID();
      const [release] = await tx.query(
        "INSERT INTO releases(id,tenant_id,project_id,agent_id,version,digest,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          releaseId,
          actor.tenantId,
          projectId,
          id,
          Number(latest?.version ?? 0) + 1,
          digest,
          snapshot,
        ],
      );
      await tx.query("UPDATE resources SET current_release_id=$1 WHERE id=$2", [releaseId, id]);
      return releaseDto(release);
    });
  }
  async releases(actor: Principal, projectId: string, agentId: string) {
    requireUser(actor);
    await this.resources.get(actor, projectId, agentId, "agent");
    return (
      await this.db.query(
        "SELECT * FROM releases WHERE agent_id=$1 AND project_id=$2 ORDER BY version DESC",
        [agentId, projectId],
      )
    ).map(releaseDto);
  }
}
