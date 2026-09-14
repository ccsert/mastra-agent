import { randomUUID } from "node:crypto";
import type { AssistantUiResultInput, AssistantUiSyncInput } from "@platform/contracts";
import {
  type AgentAppCompletion,
  AgentAppRegistration,
  AgentAppRegistrationView,
  type AgentAppSyncInput,
  AgentInput,
  AssistantBootstrap,
  AssistantContext,
  AssistantProposal,
  AssistantProposalInput,
  AssistantSession,
  type AssistantStartInput,
  type AssistantToolRequest,
  type Principal,
  platformAppRegistrationId,
  ReleaseSnapshot,
  z,
} from "@platform/contracts";
import type { Database, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import type { Conversations } from "../conversations/index.ts";
import { modelDto } from "../resources/index.ts";
import { builtinApp, completeApp, requestApp, syncApp } from "./app-ui.ts";
import { describeCapabilities, describeOperationDetail } from "./capabilities.ts";
import { type AssistantDomains, type Operation, operations } from "./operations.ts";
import { assistantInstructions, assistantSkills } from "./skills.ts";
import { assistantPagePermissions, completeUi, requestUi, syncUi } from "./ui.ts";

const stamp = (v: unknown) => new Date(String(v)).toISOString();
const sessionDto = (r: Row) =>
  AssistantSession.parse({
    id: r.id,
    title: r.title,
    createdAt: stamp(r.created_at),
    context: r.context,
  });
const proposalDto = (r: Row) =>
  AssistantProposal.parse({
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    reason: r.reason,
    status: r.status,
    actions: r.actions,
    createdAt: stamp(r.created_at),
    expiresAt: stamp(r.expires_at),
  });
type Proposal = z.infer<typeof AssistantProposal>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const reference = /^\$step\.([a-z][a-z0-9_]{0,39})\.id$/;
function substitute(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    const match = reference.exec(value);
    if (!match) return value;
    const id = ids.get(match[1]);
    if (!id) throw new ApiError(400, "INVALID_REFERENCE", `资源引用 ${match[1]} 必须指向前序步骤`);
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ids)]));
  return value;
}
/** User-delegated operations. Models may prepare changes, only the owning UI may apply them. */
export class PlatformAssistant {
  readonly registry: Operation[];
  constructor(
    readonly db: Database,
    readonly domains: AssistantDomains,
    readonly conversations: Conversations,
    readonly runtimeId: string,
  ) {
    this.registry = operations(domains);
  }
  private async allowed(actor: Principal, projectId: string) {
    if (actor.kind !== "user") throw new ApiError(403, "USER_REQUIRED", "平台助手仅供登录用户使用");
    const access = await this.domains.projects.access.project(actor, projectId);
    return this.registry.filter(
      (o) =>
        access.permissions.includes(o.permission) &&
        (!o.tenantAdmin || ["owner", "admin"].includes(access.tenantRole ?? "")),
    );
  }
  private async operation(
    actor: Principal,
    projectId: string,
    id: string,
    mode?: Operation["mode"],
  ) {
    const operation = (await this.allowed(actor, projectId)).find(
      (o) => o.id === id && (!mode || o.mode === mode),
    );
    if (!operation) throw new ApiError(403, "OPERATION_NOT_ALLOWED", "当前权限不能使用此操作");
    return operation;
  }
  async bootstrap(actor: Principal, projectId: string) {
    const available = await this.allowed(actor, projectId);
    const access = await this.domains.projects.access.project(actor, projectId);
    const [setting] = await this.db.query(
      "SELECT s.model_id,r.data->>'name' AS name FROM platform_assistant_settings s JOIN resources r ON r.id=s.model_id AND r.project_id=s.project_id WHERE s.project_id=$1",
      [projectId],
    );
    const sessions = await this.db.query(
      "SELECT c.id,c.title,c.created_at,s.context FROM platform_assistant_sessions s JOIN conversations c ON c.id=s.conversation_id WHERE c.project_id=$1 AND c.actor_id=$2 AND c.entry=$3 ORDER BY c.created_at DESC LIMIT 30",
      [projectId, actor.id, actor.entry],
    );
    return AssistantBootstrap.parse({
      configuration: setting ? { modelId: setting.model_id, modelName: setting.name } : null,
      canConfigure: access.permissions.includes("resource.manage"),
      skills: assistantSkills.map(({ id, name, description }) => ({ id, name, description })),
      operations: available.map(({ id, label, group, mode, risk }) => ({
        id,
        label,
        group,
        mode,
        risk,
      })),
      sessions: sessions.map(sessionDto),
    });
  }
  async capabilities(actor: Principal, projectId: string, conversationId?: string) {
    const available = await this.allowed(actor, projectId);
    if (conversationId) await this.session(actor, projectId, conversationId);
    const access = await this.domains.projects.access.project(actor, projectId);
    return describeCapabilities(
      this.db,
      this.registry,
      available,
      access.permissions,
      conversationId,
    );
  }
  async capabilityOperation(actor: Principal, projectId: string, operationId: string) {
    return describeOperationDetail(
      operationId,
      this.registry,
      await this.allowed(actor, projectId),
    );
  }
  async configure(actor: Principal, projectId: string, modelId: string) {
    await this.domains.projects.access.require(actor, projectId, "resource.manage");
    const model = modelDto(await this.domains.resources.get(actor, projectId, modelId, "model"));
    if (model.kind !== "chat" || model.capabilities?.toolUse === false)
      throw new ApiError(400, "MODEL_TOOL_USE", "请选择支持工具调用的对话模型");
    await this.db.transaction(async (tx) => {
      await this.domains.projects.access.require(actor, projectId, "resource.manage", tx);
      await tx.query(
        "INSERT INTO platform_assistant_settings(project_id,model_id,updated_by) VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET model_id=excluded.model_id,updated_by=excluded.updated_by,updated_at=now()",
        [projectId, modelId, actor.id],
      );
      await this.domains.projects.access.record(
        tx,
        actor,
        "assistant.configured",
        projectId,
        { modelId },
        projectId,
      );
    });
    return this.bootstrap(actor, projectId);
  }
  async start(actor: Principal, projectId: string, input: z.infer<typeof AssistantStartInput>) {
    await this.allowed(actor, projectId);
    const session = await this.db.transaction(async (tx) => {
      await this.domains.projects.access.require(actor, projectId, "project.read", tx);
      await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [projectId]);
      const [existing] = await tx.query(
        "SELECT c.id,c.title,c.created_at,s.context FROM platform_assistant_sessions s JOIN conversations c ON c.id=s.conversation_id WHERE s.project_id=$1 AND s.actor_id=$2 AND s.request_id=$3",
        [projectId, actor.id, input.requestId],
      );
      if (existing) return sessionDto(existing);
      const [setting] = await tx.query(
        "SELECT r.* FROM platform_assistant_settings s JOIN resources r ON r.id=s.model_id AND r.project_id=s.project_id WHERE s.project_id=$1",
        [projectId],
      );
      if (!setting)
        throw new ApiError(
          409,
          "ASSISTANT_NOT_CONFIGURED",
          "请先由项目管理员选择平台助手使用的模型",
        );
      const model = modelDto(setting);
      if (model.kind !== "chat" || model.capabilities?.toolUse === false)
        throw new ApiError(409, "MODEL_TOOL_USE", "助手模型已变更，请重新配置");
      const definition = AgentInput.parse({
        name: "平台助手",
        description: "代表当前用户构建和理解平台资源",
        instructions: assistantInstructions,
        modelId: model.id,
        toolIds: [],
        maxSteps: 20,
        planningEnabled: false,
        executionLimits: {
          timeoutSeconds: 900,
          maxModelCalls: 24,
          maxTokens: 400000,
          contextTokens: 16000,
          maxOutputTokens: 2048,
        },
      });
      let [resource] = await tx.query(
        "SELECT id FROM resources WHERE project_id=$1 AND kind='assistant'",
        [projectId],
      );
      if (!resource)
        [resource] = await tx.query(
          "INSERT INTO resources(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'assistant',$4) RETURNING id",
          [randomUUID(), actor.tenantId, projectId, definition],
        );
      const snapshot = ReleaseSnapshot.parse({
        agent: definition,
        model,
        tools: [],
        skills: [],
        knowledgeBases: [],
        adapterVersion: "mastra-agent-v1",
      });
      const [last] = await tx.query(
        "SELECT coalesce(max(version),0)+1 AS version FROM releases WHERE agent_id=$1",
        [resource.id],
      );
      const releaseId = randomUUID(),
        conversationId = randomUUID();
      await tx.query(
        "INSERT INTO releases(id,tenant_id,project_id,agent_id,version,digest,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          releaseId,
          actor.tenantId,
          projectId,
          resource.id,
          last.version,
          sha256(JSON.stringify(snapshot)),
          snapshot,
        ],
      );
      const [conversation] = await tx.query(
        "INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title) VALUES($1,$2,$3,$4,$5,$6,$7,'新会话') RETURNING id,title,created_at",
        [conversationId, actor.tenantId, projectId, actor.id, actor.entry, resource.id, releaseId],
      );
      await tx.query(
        "INSERT INTO platform_assistant_sessions(conversation_id,request_id,actor_id,project_id,context) VALUES($1,$2,$3,$4,$5)",
        [conversationId, input.requestId, actor.id, projectId, input.context],
      );
      return sessionDto({ ...conversation, context: input.context });
    });
    if (input.message)
      await this.conversations.createRun(
        actor,
        projectId,
        session.id,
        input.message,
        input.requestId,
        [],
        true,
      );
    return session;
  }
  async session(actor: Principal, projectId: string, id: string) {
    await this.allowed(actor, projectId);
    await this.conversations.get(actor, projectId, id);
    const [session] = await this.db.query(
      "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 AND actor_id=$2 AND project_id=$3",
      [id, actor.id, projectId],
    );
    if (!session) throw notFound();
  }
  async proposals(actor: Principal, projectId: string, id: string) {
    await this.session(actor, projectId, id);
    return (
      await this.db.query(
        "SELECT * FROM platform_assistant_proposals WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 30",
        [id],
      )
    ).map(proposalDto);
  }
  async apps(actor: Principal, projectId: string) {
    if (actor.kind !== "user") throw new ApiError(403, "USER_REQUIRED", "应用协作仅供登录用户使用");
    const access = await this.domains.projects.access.project(actor, projectId);
    if (!access.permissions.includes("resource.read")) return [builtinApp];
    const rows = await this.db.query(
      "SELECT * FROM assistant_app_registrations WHERE project_id=$1 ORDER BY created_at",
      [projectId],
    );
    return [
      builtinApp,
      ...rows.map((row) =>
        AgentAppRegistrationView.parse({ id: row.id, url: row.url, manifest: row.manifest }),
      ),
    ];
  }
  async registerApp(
    actor: Principal,
    projectId: string,
    raw: z.infer<typeof AgentAppRegistration>,
  ) {
    await this.domains.projects.access.require(actor, projectId, "resource.manage");
    if (actor.kind !== "user") throw new ApiError(403, "USER_REQUIRED", "应用协作仅供登录用户使用");
    const input = AgentAppRegistration.parse(raw);
    if (input.manifest.appId === builtinApp.manifest.appId)
      throw new ApiError(400, "RESERVED_APP_ID", "内置应用标识不能被注册");
    const [row] = await this.db.query(
      "INSERT INTO assistant_app_registrations(id,project_id,url,manifest,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *",
      [randomUUID(), projectId, input.url, input.manifest, actor.id],
    );
    if (!row) throw new ApiError(409, "APP_EXISTS", "此应用已登记，请先移除旧版本");
    return AgentAppRegistrationView.parse({ id: row.id, ...input });
  }
  async removeApp(actor: Principal, projectId: string, id: string) {
    if (actor.kind !== "user") throw new ApiError(403, "USER_REQUIRED", "应用协作仅供登录用户使用");
    await this.domains.projects.access.require(actor, projectId, "resource.manage");
    if (id === platformAppRegistrationId)
      throw new ApiError(400, "BUILTIN_APP", "不能移除内置应用");
    await this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "DELETE FROM assistant_app_registrations WHERE id=$1 AND project_id=$2 RETURNING id",
        [id, projectId],
      );
      if (!row) throw notFound();
      await tx.query("DELETE FROM assistant_app_sessions WHERE registration_id=$1", [id]);
    });
    return { removed: true };
  }
  async syncApp(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof AgentAppSyncInput>,
  ) {
    await this.session(actor, projectId, id);
    return syncApp(
      this.db,
      projectId,
      id,
      (await this.domains.projects.access.project(actor, projectId)).permissions,
      input,
    );
  }
  async completeApp(
    actor: Principal,
    projectId: string,
    id: string,
    actionId: string,
    input: z.infer<typeof AgentAppCompletion>,
  ) {
    await this.session(actor, projectId, id);
    return completeApp(
      this.db,
      projectId,
      id,
      actionId,
      (await this.domains.projects.access.project(actor, projectId)).permissions,
      input,
    );
  }
  async syncUi(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof AssistantUiSyncInput>,
  ) {
    await this.session(actor, projectId, id);
    return syncUi(
      this.db,
      id,
      (await this.domains.projects.access.project(actor, projectId)).permissions,
      input,
    );
  }
  async completeUi(
    actor: Principal,
    projectId: string,
    id: string,
    actionId: string,
    input: z.infer<typeof AssistantUiResultInput>,
  ) {
    await this.session(actor, projectId, id);
    return completeUi(
      this.db,
      id,
      actionId,
      (await this.domains.projects.access.project(actor, projectId)).permissions,
      input,
    );
  }
  async runtime(runId: string, input: z.infer<typeof AssistantToolRequest>) {
    const [run] = await this.db.query(
      `SELECT r.*,u.display_name,s.context FROM runs r
      JOIN platform_assistant_sessions s ON s.conversation_id=r.conversation_id AND s.actor_id=r.actor_id AND s.project_id=r.project_id
      JOIN users u ON u.id=r.actor_id AND u.tenant_id=r.tenant_id AND u.active
      WHERE r.id=$1 AND r.runtime_id=$2 AND r.lease_token=$3 AND r.status='running' AND NOT r.cancel_requested AND r.lease_until>clock_timestamp() AND r.deadline>clock_timestamp()`,
      [runId, this.runtimeId, input.leaseToken],
    );
    if (!run)
      throw new ApiError(409, "ASSISTANT_LEASE_EXPIRED", "助手运行已取消、撤权或租约已失效");
    const actor: Principal = {
        id: String(run.actor_id),
        tenantId: String(run.tenant_id),
        entry: String(run.entry),
        kind: "user",
        displayName: String(run.display_name),
      },
      projectId = String(run.project_id),
      conversationId = String(run.conversation_id);
    const available = await this.allowed(actor, projectId);
    if (input.tool === "app")
      return requestApp(
        this.db,
        projectId,
        conversationId,
        runId,
        input.toolCallId,
        (await this.domains.projects.access.project(actor, projectId)).permissions,
        input.input,
      );
    if (input.tool === "ui")
      return requestUi(
        this.db,
        conversationId,
        runId,
        input.toolCallId,
        (await this.domains.projects.access.project(actor, projectId)).permissions,
        input.input,
      );
    if (input.tool === "catalog") {
      const query = z
        .object({ group: z.string().max(80).optional(), operation: z.string().max(80).optional() })
        .strict()
        .parse(input.input);
      return {
        operations: available
          .filter(
            (o) =>
              (!query.group || o.group === query.group) &&
              (!query.operation || o.id === query.operation),
          )
          .map((o) => ({
            id: o.id,
            label: o.label,
            mode: o.mode,
            risk: o.risk,
            ...(query.operation || (query.group && o.mode === "read")
              ? { schema: z.toJSONSchema(o.schema, { unrepresentable: "any" }) }
              : {}),
          })),
        context: AssistantContext.parse(run.context),
      };
    }
    if (input.tool === "skill") {
      const { id } = z.object({ id: z.string() }).strict().parse(input.input),
        skill = assistantSkills.find((s) => s.id === id);
      if (!skill) throw notFound();
      return { skill, version: 1 };
    }
    if (input.tool === "navigate") {
      const destination = AssistantContext.parse(input.input);
      const permissions = assistantPagePermissions;
      const access = await this.domains.projects.access.project(actor, projectId);
      if (!access.permissions.includes(permissions[destination.page]))
        throw new ApiError(403, "FORBIDDEN", "无权访问目标页面");
      if (
        destination.page === "agents" &&
        destination.resourceId &&
        !access.permissions.includes("resource.read")
      )
        throw new ApiError(403, "FORBIDDEN", "当前角色不能查看 Agent 草稿配置");
      if (destination.page === "team") await this.domains.projects.access.manageTenant(actor);
      return {
        type: "platform-navigation",
        projectId,
        ...destination,
        execution: "suggestion",
        message: "已准备页面入口，等待用户打开",
      };
    }
    if (input.tool === "read") {
      const request = z
        .object({ operation: z.string(), input: z.record(z.string(), z.unknown()).default({}) })
        .strict()
        .parse(input.input);
      if (request.operation === "proposals")
        return { items: await this.proposals(actor, projectId, conversationId) };
      const operation = await this.operation(actor, projectId, request.operation, "read");
      const result = await operation.run(actor, projectId, request.input);
      if (JSON.stringify(result).length > 100000)
        return { limited: true, message: "结果超过读取上限，请缩小对象范围或在界面查看" };
      return result;
    }
    const proposal = AssistantProposalInput.parse(input.input),
      keys = new Map<string, string>();
    const actions: Proposal["actions"] = [];
    for (const step of proposal.actions) {
      if (keys.has(step.key)) throw new ApiError(400, "DUPLICATE_STEP", "变更步骤标识不能重复");
      const operation = await this.operation(actor, projectId, step.operation, "write");
      const checked = operation.schema.safeParse(substitute(step.input, keys));
      if (!checked.success)
        throw new ApiError(
          400,
          "INVALID_ACTION",
          `${operation.label} 参数不完整：${checked.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；")
            .slice(0, 1500)}`,
        );
      keys.set(step.key, "00000000-0000-4000-8000-000000000001");
      actions.push({
        ...step,
        label: operation.label,
        risk: operation.risk,
        status: "pending",
        result: null,
        error: null,
      });
    }
    if (actions.some((a) => a.risk !== "draft") && actions.length > 1)
      throw new ApiError(400, "SEPARATE_APPROVAL", "发布或权限变更须单独审阅，请拆成独立变更");
    const [saved] = await this.db.query(
      "INSERT INTO platform_assistant_proposals(id,conversation_id,run_id,tool_call_id,title,reason,actions) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,tool_call_id) DO UPDATE SET tool_call_id=excluded.tool_call_id RETURNING *",
      [
        randomUUID(),
        conversationId,
        runId,
        input.toolCallId,
        proposal.title,
        proposal.reason,
        JSON.stringify(actions),
      ],
    );
    const output = proposalDto(saved);
    if (
      canonical({
        title: output.title,
        reason: output.reason,
        actions: output.actions.map(({ key, operation, input }) => ({ key, operation, input })),
      }) !== canonical(proposal)
    )
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一工具调用不能更换变更参数");
    return { proposal: output, message: "变更已准备，尚未应用。请用户在任务台审阅后应用。" };
  }
  async apply(
    actor: Principal,
    projectId: string,
    conversationId: string,
    id: string,
    dismiss = false,
  ) {
    await this.session(actor, projectId, conversationId);
    const { proposal, execute } = await this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT * FROM platform_assistant_proposals WHERE id=$1 AND conversation_id=$2 FOR UPDATE",
        [id, conversationId],
      );
      if (!row) throw notFound();
      const proposal = proposalDto(row);
      if (proposal.status !== "pending") return { proposal, execute: false };
      if (!dismiss && new Date(proposal.expiresAt).getTime() < Date.now())
        throw new ApiError(409, "PROPOSAL_EXPIRED", "变更预览已过期，请助手重新生成");
      if (!dismiss)
        for (const action of proposal.actions)
          await this.operation(actor, projectId, action.operation, "write");
      proposal.status = dismiss ? "dismissed" : "applying";
      await tx.query("UPDATE platform_assistant_proposals SET status=$1 WHERE id=$2", [
        proposal.status,
        id,
      ]);
      await this.domains.projects.access.record(
        tx,
        actor,
        dismiss ? "assistant.dismissed" : "assistant.approved",
        id,
        { operations: proposal.actions.map((a) => a.operation) },
        projectId,
      );
      return { proposal, execute: !dismiss };
    });
    if (!execute) return proposal;
    const ids = new Map<string, string>();
    for (const action of proposal.actions) {
      try {
        const operation = await this.operation(actor, projectId, action.operation, "write");
        action.status = "running";
        await this.db.query("UPDATE platform_assistant_proposals SET actions=$1 WHERE id=$2", [
          JSON.stringify(proposal.actions),
          id,
        ]);
        const result = await operation.run(actor, projectId, substitute(action.input, ids));
        action.result = z.record(z.string(), z.unknown()).parse(result);
        if (typeof action.result.id === "string") ids.set(action.key, action.result.id);
        action.status = "succeeded";
        await this.db.query("UPDATE platform_assistant_proposals SET actions=$1 WHERE id=$2", [
          JSON.stringify(proposal.actions),
          id,
        ]);
        await this.domains.projects.access.record(
          this.db,
          actor,
          "assistant.action_applied",
          id,
          { operation: action.operation, resultId: action.result.id ?? null },
          projectId,
        );
      } catch (error) {
        action.status =
          error instanceof ApiError || error instanceof z.ZodError ? "failed" : "unknown";
        action.error =
          error instanceof ApiError
            ? error.message
            : error instanceof z.ZodError
              ? "资源参数已变化，请重新生成变更"
              : "执行结果未能确认，请先检查资源，避免重复创建";
        proposal.status = "failed";
        await this.db.query(
          "UPDATE platform_assistant_proposals SET status=$1,actions=$2 WHERE id=$3",
          [proposal.status, JSON.stringify(proposal.actions), id],
        );
        return proposal;
      }
    }
    proposal.status = "succeeded";
    await this.db.query(
      "UPDATE platform_assistant_proposals SET status=$1,actions=$2 WHERE id=$3",
      [proposal.status, JSON.stringify(proposal.actions), id],
    );
    return proposal;
  }
}
