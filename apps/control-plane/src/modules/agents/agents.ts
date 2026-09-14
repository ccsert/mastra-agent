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
    hasUnpublishedChanges:
      !r.snapshot ||
      JSON.stringify(AgentInput.parse(data(r))) !==
        JSON.stringify(ReleaseSnapshot.parse(r.snapshot).agent),
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
    sourceRevision: r.source_revision ?? null,
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
    const access = await this.projects.access.require(actor, projectId, "project.read");
    const authoring = access.permissions.includes("resource.read");
    return (
      await this.db.query(
        "SELECT a.*,r.snapshot,r.version AS published_version FROM resources a LEFT JOIN releases r ON r.id=a.current_release_id WHERE a.project_id=$1 AND a.kind='agent' ORDER BY a.created_at DESC",
        [projectId],
      )
    )
      .filter((r) => authoring || !!r.current_release_id)
      .map((r) =>
        agentDto(authoring ? r : { ...r, data: ReleaseSnapshot.parse(r.snapshot).agent }),
      );
  }
  async validate(actor: Principal, projectId: string, input: AgentInput, tx: Queryable = this.db) {
    const model = modelDto(await this.resources.get(actor, projectId, input.modelId, "model", tx));
    if (model.kind !== "chat") throw new ApiError(400, "MODEL_KIND", "Agent 必须绑定对话模型");
    // Tools and knowledge bases are both reached through tool calling, so a model
    // declared as unable to call tools cannot serve either. The check reads the
    // operator's own declaration; it never probes the service.
    if (
      model.capabilities?.toolUse === false &&
      (input.toolIds.length > 0 ||
        (input.knowledgeBaseIds?.length ?? 0) > 0 ||
        input.delegation?.enabled ||
        input.planningEnabled ||
        input.workspaceEnabled ||
        (input.maxSteps ?? 5) > 10)
    )
      throw new ApiError(
        400,
        "MODEL_TOOL_USE",
        "该模型被标记为不支持工具调用，无法绑定工具、知识库或启用计划与子代理；如判断有误，请先在模型设置中更正声明",
      );
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
          [
            "run_skill_script",
            "skill",
            "skill_search",
            "skill_read",
            "delegate_task",
            "update_plan",
          ].includes(name) ||
          name.startsWith("mastra_"))
      )
        throw new ApiError(400, "RESERVED_TOOL_NAME", "该工具名由平台保留");
      if (names.has(name)) throw new ApiError(400, "DUPLICATE_TOOL_NAMES", "工具名称不能重复");
      names.add(name);
    }
  }
  private async scriptGrants(
    actor: Principal,
    projectId: string,
    input: AgentInput,
    id?: string,
    tx: Queryable = this.db,
  ) {
    const access = await this.projects.access.project(actor, projectId, tx);
    if (access.permissions.includes("agent.publish")) return;
    const [published] = id
      ? await tx.query(
          "SELECT r.snapshot FROM resources a JOIN releases r ON r.id=a.current_release_id WHERE a.id=$1 AND a.project_id=$2",
          [id, projectId],
        )
      : [];
    const bindings = published ? ReleaseSnapshot.parse(published.snapshot).agent.skillBindings : [];
    if (
      (input.skillBindings ?? []).some((binding) =>
        (binding.entrypoints ?? []).some(
          (path) =>
            !bindings.some(
              (approved) =>
                approved.versionId === binding.versionId && approved.entrypoints.includes(path),
            ),
        ),
      )
    )
      throw new ApiError(
        403,
        "SKILL_AUTHORIZATION_REQUIRED",
        "新增 Skill 脚本授权需要项目管理员确认并发布",
      );
  }
  async create(actor: Principal, projectId: string, input: AgentInput) {
    requireUser(actor);
    await this.projects.access.require(actor, projectId, "agent.edit");
    await this.scriptGrants(actor, projectId, input);
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
    await this.projects.access.require(actor, projectId, "agent.edit");
    await this.resources.get(actor, projectId, id, "agent");
    await this.scriptGrants(actor, projectId, input, id);
    await this.validate(actor, projectId, input);
    const [r] = await this.db.query(
      "UPDATE resources SET data=$1,revision=revision+1 WHERE id=$2 AND project_id=$3 AND revision=$4 RETURNING *",
      [input, id, projectId, baseRevision],
    );
    if (!r) throw new ApiError(409, "DRAFT_CONFLICT", "草稿已被修改，请刷新后重试");
    return agentDto(r);
  }
  private async snapshot(
    actor: Principal,
    projectId: string,
    agent: ReturnType<typeof AgentInput.parse>,
    tx: Queryable,
  ) {
    const model = modelDto(await this.resources.get(actor, projectId, agent.modelId, "model", tx)),
      tools = [];
    for (const toolId of agent.toolIds)
      tools.push(toolDto(await this.resources.get(actor, projectId, toolId, "tool", tx)));
    const knowledgeBases = [];
    for (const kbId of agent.knowledgeBaseIds)
      knowledgeBases.push(await this.resources.knowledgeSnapshot(actor, projectId, kbId, tx));
    return ReleaseSnapshot.parse({
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
  }
  async publish(actor: Principal, projectId: string, id: string, baseRevision: number) {
    requireUser(actor);
    await this.projects.access.require(actor, projectId, "agent.publish");
    return this.db.transaction(async (tx) => {
      const resource = await this.resources.get(actor, projectId, id, "agent", tx, true);
      if (resource.revision !== baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请刷新后发布");
      const agent = AgentInput.parse(resource.data);
      await this.validate(actor, projectId, agent, tx);
      const snapshot = await this.snapshot(actor, projectId, agent, tx);
      const digest = sha256(JSON.stringify(snapshot));
      const [latest] = await tx.query(
        "SELECT * FROM releases WHERE agent_id=$1 AND kind='published' ORDER BY version DESC LIMIT 1",
        [id],
      );
      if (latest?.digest === digest) return releaseDto(latest);
      const releaseId = randomUUID();
      const [release] = await tx.query(
        "INSERT INTO releases(id,tenant_id,project_id,agent_id,version,digest,snapshot,source_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          releaseId,
          actor.tenantId,
          projectId,
          id,
          Number(latest?.version ?? 0) + 1,
          digest,
          snapshot,
          baseRevision,
        ],
      );
      await tx.query("UPDATE resources SET current_release_id=$1 WHERE id=$2", [releaseId, id]);
      await this.projects.access.record(
        tx,
        actor,
        "agent.published",
        id,
        { version: release.version, draftRevision: baseRevision },
        projectId,
      );
      return releaseDto(release);
    });
  }
  async preview(
    actor: Principal,
    projectId: string,
    id: string,
    baseRevision: number,
    requestId: string,
  ) {
    await this.projects.access.require(actor, projectId, "agent.edit");
    return this.db.transaction(async (tx) => {
      const resource = await this.resources.get(actor, projectId, id, "agent", tx, true);
      const [existing] = await tx.query(
        "SELECT r.*,c.id AS conversation_id FROM releases r JOIN conversations c ON c.release_id=r.id WHERE r.project_id=$1 AND r.preview_actor_id=$2 AND r.preview_request_id=$3",
        [projectId, actor.id, requestId],
      );
      if (existing) {
        if (existing.agent_id !== id || Number(existing.source_revision) !== baseRevision)
          throw new ApiError(409, "PREVIEW_CONFLICT", "试用请求与原始草稿不一致");
        return {
          conversationId: String(existing.conversation_id),
          releaseId: String(existing.id),
          draftRevision: baseRevision,
        };
      }
      if (Number(resource.revision) !== baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请刷新后试用");
      const agent = AgentInput.parse(resource.data);
      await this.scriptGrants(actor, projectId, agent, id, tx);
      await this.validate(actor, projectId, agent, tx);
      const snapshot = await this.snapshot(actor, projectId, agent, tx),
        releaseId = randomUUID(),
        conversationId = randomUUID();
      await tx.query(
        "INSERT INTO releases(id,tenant_id,project_id,agent_id,version,digest,snapshot,kind,source_revision,preview_actor_id,preview_request_id) VALUES($1,$2,$3,$4,0,$5,$6,'preview',$7,$8,$9)",
        [
          releaseId,
          actor.tenantId,
          projectId,
          id,
          sha256(JSON.stringify(snapshot)),
          snapshot,
          baseRevision,
          actor.id,
          requestId,
        ],
      );
      await tx.query(
        "INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          conversationId,
          actor.tenantId,
          projectId,
          actor.id,
          actor.entry,
          id,
          releaseId,
          `草稿试用 · ${agent.name}`,
        ],
      );
      await this.projects.access.record(
        tx,
        actor,
        "agent.preview_created",
        id,
        { draftRevision: baseRevision, conversationId },
        projectId,
      );
      return { conversationId, releaseId, draftRevision: baseRevision };
    });
  }
  async releases(actor: Principal, projectId: string, agentId: string) {
    requireUser(actor);
    await this.projects.access.require(actor, projectId, "resource.read");
    await this.resources.get(actor, projectId, agentId, "agent");
    return (
      await this.db.query(
        "SELECT * FROM releases WHERE agent_id=$1 AND project_id=$2 AND kind='published' ORDER BY version DESC",
        [agentId, projectId],
      )
    ).map(releaseDto);
  }
}
