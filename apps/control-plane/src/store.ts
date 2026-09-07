import { randomBytes, randomUUID } from "node:crypto";
import {
  Agent,
  AgentInput,
  Application,
  Conversation,
  Model,
  type ModelInput,
  type Principal,
  Project,
  Release,
  ReleaseSnapshot,
  Run,
  RunEvent,
  Tool,
  type ToolInput,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import Ajv from "ajv";
import {
  hashPassword,
  secureEqual,
  sha256,
  signRequest,
  type Vault,
  verifyPassword,
} from "./crypto.ts";
import { ApiError, notFound } from "./errors.ts";

const text = (r: Row, key: string) => String(r[key]);
const date = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const data = (r: Row) => r.data as Record<string, unknown>;
const modelDto = (r: Row) =>
  Model.parse({
    ...data(r),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    createdAt: date(r.created_at),
    provider: "openai-compatible",
  });
const toolDto = (r: Row) =>
  Tool.parse({
    ...data(r),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    createdAt: date(r.created_at),
    version: 1,
  });
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
const releaseDto = (r: Row) =>
  Release.parse({
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    version: r.version,
    digest: r.digest,
    snapshot: r.snapshot,
    createdAt: date(r.created_at),
  });
const conversationDto = (r: Row) =>
  Conversation.parse({
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    releaseId: r.release_id,
    releaseVersion: r.version,
    title: r.title,
    createdAt: date(r.created_at),
  });
const runDto = (r: Row) =>
  Run.parse({
    id: r.id,
    conversationId: r.conversation_id,
    releaseId: r.release_id,
    releaseVersion: r.version,
    agentName: r.agent_name,
    status: r.status,
    runtimeId: r.runtime_id,
    createdAt: date(r.created_at),
    finishedAt: r.finished_at ? date(r.finished_at) : null,
    errorCode: r.error_code,
    outputText: r.output_text,
  });
const appDto = (r: Row) =>
  Application.parse({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    accessKey: r.access_key,
    active: r.active,
    createdAt: date(r.created_at),
  });
export class Store {
  constructor(
    readonly db: Database,
    readonly vault: Vault,
    readonly runtimeId = "hosted-local",
  ) {}
  async initialize() {
    await this.db.migrate();
    await this.db.query("INSERT INTO runtimes(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [
      this.runtimeId,
      "平台托管 Runtime",
    ]);
  }
  async isSetup() {
    return (await this.db.query("SELECT id FROM users LIMIT 1")).length > 0;
  }
  async setup(username: string, password: string, workspaceName: string) {
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(2947302)");
      if ((await tx.query("SELECT id FROM users LIMIT 1")).length)
        throw new ApiError(409, "ALREADY_INITIALIZED", "平台已初始化，请登录");
      const tenantId = randomUUID(),
        userId = randomUUID();
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [tenantId, workspaceName]);
      await tx.query(
        "INSERT INTO users(id,tenant_id,username,display_name,password_hash) VALUES($1,$2,$3,$4,$5)",
        [userId, tenantId, username, username, passwordHash],
      );
      return { tenantId, userId };
    });
  }
  async login(username: string, password: string) {
    const [user] = await this.db.query("SELECT * FROM users WHERE username=$1", [username]);
    if (!user) {
      await hashPassword(password);
      throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    }
    if (!(await verifyPassword(password, text(user, "password_hash"))))
      throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    const token = randomBytes(32).toString("hex");
    await this.db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
      [sha256(token), user.id],
    );
    return token;
  }
  async logout(token: string) {
    await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  }
  async session(token: string): Promise<Principal> {
    const [r] = await this.db.query(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [sha256(token)],
    );
    if (!r) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
    return {
      id: text(r, "id"),
      tenantId: text(r, "tenant_id"),
      displayName: text(r, "display_name"),
      kind: "user",
      entry: "console",
    };
  }
  async application(request: Request): Promise<Principal> {
    const auth = request.headers.get("authorization") ?? "",
      timestamp = request.headers.get("x-platform-date") ?? "",
      nonce = request.headers.get("x-platform-nonce") ?? "";
    const match = /^Platform-HMAC ([a-f0-9-]+):([a-f0-9]+):([a-f0-9]{64})$/.exec(auth);
    if (
      !match ||
      !Number.isFinite(Date.parse(timestamp)) ||
      Math.abs(Date.now() - Date.parse(timestamp)) > 300000 ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(nonce)
    )
      throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const [, id, accessKey, signature] = match;
    const [app] = await this.db.query(
      "SELECT * FROM applications WHERE id=$1 AND access_key=$2 AND active=true",
      [id, accessKey],
    );
    if (!app) throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const url = new URL(request.url),
      body = await request.clone().text();
    const expected = signRequest(
      request.method,
      url.pathname + url.search,
      timestamp,
      nonce,
      body,
      this.vault.decrypt(text(app, "secret_enc")),
    );
    if (!secureEqual(signature, expected))
      throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const inserted = await this.db.query(
      "INSERT INTO auth_nonces(application_id,nonce,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING nonce",
      [id, nonce],
    );
    if (!inserted.length) throw new ApiError(401, "REPLAY_DETECTED", "请求签名已使用");
    return {
      id,
      tenantId: text(app, "tenant_id"),
      projectId: text(app, "project_id"),
      displayName: text(app, "name"),
      kind: "application",
      entry: `app:${id}`,
    };
  }
  requireUser(actor: Principal) {
    if (actor.kind !== "user")
      throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用凭据仅用于调用已发布 Agent");
  }
  async project(actor: Principal, id: string, tx: Queryable = this.db) {
    if (actor.kind === "application" && actor.projectId !== id) throw notFound();
    const [r] = await tx.query("SELECT * FROM projects WHERE id=$1 AND tenant_id=$2", [
      id,
      actor.tenantId,
    ]);
    if (!r) throw notFound();
    return Project.parse({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      description: r.description,
      createdAt: date(r.created_at),
    });
  }
  async projects(actor: Principal) {
    const rows = await this.db.query(
      "SELECT * FROM projects WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at",
      [actor.tenantId, actor.projectId ?? null],
    );
    return rows.map((r) =>
      Project.parse({
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        description: r.description,
        createdAt: date(r.created_at),
      }),
    );
  }
  async createProject(actor: Principal, input: { name: string; description: string }) {
    this.requireUser(actor);
    const id = randomUUID();
    await this.db.query("INSERT INTO projects(id,tenant_id,name,description) VALUES($1,$2,$3,$4)", [
      id,
      actor.tenantId,
      input.name,
      input.description,
    ]);
    return this.project(actor, id);
  }
  async resource(
    actor: Principal,
    projectId: string,
    id: string,
    kind: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.project(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT * FROM resources WHERE id=$1 AND project_id=$2 AND tenant_id=$3 AND kind=$4 ${lock ? "FOR UPDATE" : ""}`,
      [id, projectId, actor.tenantId, kind],
    );
    if (!r) throw notFound();
    return r;
  }
  async models(actor: Principal, projectId: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='model' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(modelDto);
  }
  async createModel(actor: Principal, projectId: string, input: ModelInput) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    const { apiKey, ...payload } = input,
      id = randomUUID();
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data,secret_enc) VALUES($1,$2,$3,'model',$4,$5) RETURNING *",
      [id, actor.tenantId, projectId, payload, this.vault.encrypt(apiKey)],
    );
    return modelDto(r);
  }
  async tools(actor: Principal, projectId: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM resources WHERE project_id=$1 AND kind='tool' ORDER BY created_at DESC",
        [projectId],
      )
    ).map(toolDto);
  }
  async createTool(actor: Principal, projectId: string, input: ToolInput) {
    this.requireUser(actor);
    await this.project(actor, projectId);
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
  async agents(actor: Principal, projectId: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT a.*,r.version AS published_version FROM resources a LEFT JOIN releases r ON r.id=a.current_release_id WHERE a.project_id=$1 AND a.kind='agent' ORDER BY a.created_at DESC",
        [projectId],
      )
    ).map(agentDto);
  }
  async validateAgent(
    actor: Principal,
    projectId: string,
    input: AgentInput,
    tx: Queryable = this.db,
  ) {
    await this.resource(actor, projectId, input.modelId, "model", tx);
    if (new Set(input.toolIds).size !== input.toolIds.length)
      throw new ApiError(400, "DUPLICATE_TOOLS", "同一工具不能重复绑定");
    const names = new Set();
    for (const id of input.toolIds) {
      const tool = await this.resource(actor, projectId, id, "tool", tx);
      const name = data(tool).name;
      if (names.has(name)) throw new ApiError(400, "DUPLICATE_TOOL_NAMES", "工具名称不能重复");
      names.add(name);
    }
  }
  async createAgent(actor: Principal, projectId: string, input: AgentInput) {
    this.requireUser(actor);
    await this.validateAgent(actor, projectId, input);
    const [r] = await this.db.query(
      "INSERT INTO resources(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'agent',$4) RETURNING *",
      [randomUUID(), actor.tenantId, projectId, input],
    );
    return agentDto(r);
  }
  async updateAgent(
    actor: Principal,
    projectId: string,
    id: string,
    input: AgentInput,
    baseRevision: number,
  ) {
    this.requireUser(actor);
    await this.resource(actor, projectId, id, "agent");
    await this.validateAgent(actor, projectId, input);
    const [r] = await this.db.query(
      "UPDATE resources SET data=$1,revision=revision+1 WHERE id=$2 AND project_id=$3 AND revision=$4 RETURNING *",
      [input, id, projectId, baseRevision],
    );
    if (!r) throw new ApiError(409, "DRAFT_CONFLICT", "草稿已被修改，请刷新后重试");
    return agentDto(r);
  }
  async publish(actor: Principal, projectId: string, id: string, baseRevision: number) {
    this.requireUser(actor);
    return this.db.transaction(async (tx) => {
      const resource = await this.resource(actor, projectId, id, "agent", tx, true);
      if (resource.revision !== baseRevision)
        throw new ApiError(409, "DRAFT_CONFLICT", "草稿已变化，请刷新后发布");
      const agent = AgentInput.parse(resource.data);
      await this.validateAgent(actor, projectId, agent, tx);
      const model = modelDto(await this.resource(actor, projectId, agent.modelId, "model", tx)),
        tools = [];
      for (const toolId of agent.toolIds)
        tools.push(toolDto(await this.resource(actor, projectId, toolId, "tool", tx)));
      const snapshot = ReleaseSnapshot.parse({
        agent,
        model,
        tools,
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
    this.requireUser(actor);
    await this.resource(actor, projectId, agentId, "agent");
    return (
      await this.db.query(
        "SELECT * FROM releases WHERE agent_id=$1 AND project_id=$2 ORDER BY version DESC",
        [agentId, projectId],
      )
    ).map(releaseDto);
  }
  async conversations(actor: Principal, projectId: string) {
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT c.*,r.version FROM conversations c JOIN releases r ON r.id=c.release_id WHERE c.project_id=$1 AND c.actor_id=$2 AND c.entry=$3 ORDER BY c.created_at DESC",
        [projectId, actor.id, actor.entry],
      )
    ).map(conversationDto);
  }
  async conversation(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.project(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT c.*,r.version FROM conversations c JOIN releases r ON r.id=c.release_id WHERE c.id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.entry=$4 ${lock ? "FOR UPDATE OF c" : ""}`,
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return conversationDto(r);
  }
  async createConversation(actor: Principal, projectId: string, agentId: string, title: string) {
    const agent = await this.resource(actor, projectId, agentId, "agent");
    if (!agent.current_release_id) throw new ApiError(409, "AGENT_NOT_PUBLISHED", "请先发布 Agent");
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        actor.tenantId,
        projectId,
        actor.id,
        actor.entry,
        agentId,
        agent.current_release_id,
        title,
      ],
    );
    return this.conversation(actor, projectId, id);
  }
  async messages(actor: Principal, projectId: string, conversationId: string) {
    await this.conversation(actor, projectId, conversationId);
    return (
      await this.db.query("SELECT data FROM messages WHERE conversation_id=$1 ORDER BY position", [
        conversationId,
      ])
    ).map((r) => r.data);
  }
  async createRun(
    actor: Principal,
    projectId: string,
    conversationId: string,
    input: string,
    requestId: string,
  ) {
    const runId = await this.db.transaction(async (tx) => {
      const conversation = await this.conversation(actor, projectId, conversationId, tx, true),
        hash = sha256(input);
      const [prior] = await tx.query(
        "SELECT id,input_hash FROM runs WHERE conversation_id=$1 AND request_id=$2",
        [conversationId, requestId],
      );
      if (prior) {
        if (prior.input_hash !== hash)
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容");
        return text(prior, "id");
      }
      if (
        (
          await tx.query(
            "SELECT id FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
            [conversationId],
          )
        ).length
      )
        throw new ApiError(409, "CONVERSATION_BUSY", "此会话正在执行，请等待完成或取消");
      const id = randomUUID(),
        messageId = randomUUID();
      await tx.query(
        "INSERT INTO runs(id,tenant_id,project_id,actor_id,entry,conversation_id,release_id,request_id,input_hash,runtime_id,status,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',now()+interval '3 minutes')",
        [
          id,
          actor.tenantId,
          projectId,
          actor.id,
          actor.entry,
          conversationId,
          conversation.releaseId,
          requestId,
          hash,
          this.runtimeId,
        ],
      );
      await tx.query("INSERT INTO messages(id,conversation_id,data) VALUES($1,$2,$3)", [
        messageId,
        conversationId,
        { id: messageId, role: "user", parts: [{ type: "text", text: input }] },
      ]);
      return id;
    });
    return this.run(actor, projectId, runId);
  }
  async run(actor: Principal, projectId: string, id: string) {
    await this.project(actor, projectId);
    const [r] = await this.db.query(
      "SELECT q.*,r.version,r.snapshot->'agent'->>'name' AS agent_name FROM runs q JOIN releases r ON q.release_id=r.id WHERE q.id=$1 AND q.project_id=$2 AND q.actor_id=$3 AND q.entry=$4",
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return runDto(r);
  }
  async runs(actor: Principal, projectId: string) {
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT q.*,r.version,r.snapshot->'agent'->>'name' AS agent_name FROM runs q JOIN releases r ON q.release_id=r.id WHERE q.project_id=$1 AND q.actor_id=$2 AND q.entry=$3 ORDER BY q.created_at DESC LIMIT 100",
        [projectId, actor.id, actor.entry],
      )
    ).map(runDto);
  }
  async events(actor: Principal, projectId: string, id: string, after = -1) {
    await this.run(actor, projectId, id);
    return (
      await this.db.query(
        "SELECT * FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 500",
        [id, after],
      )
    ).map((r) => RunEvent.parse({ seq: r.seq, chunk: r.chunk, createdAt: date(r.created_at) }));
  }
  async cancel(actor: Principal, projectId: string, id: string) {
    await this.run(actor, projectId, id);
    await this.db.query(
      "UPDATE runs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 AND status IN ('queued','running')",
      [id],
    );
    return this.run(actor, projectId, id);
  }
  async runtimes(actor: Principal) {
    this.requireUser(actor);
    return (await this.db.query("SELECT * FROM runtimes WHERE id=$1", [this.runtimeId])).map(
      (r) => ({
        id: text(r, "id"),
        name: text(r, "name"),
        lastSeenAt: r.last_seen_at ? date(r.last_seen_at) : null,
        online: !!r.last_seen_at && Date.now() - new Date(date(r.last_seen_at)).valueOf() < 15000,
      }),
    );
  }
  async applications(actor: Principal, projectId: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM applications WHERE project_id=$1 ORDER BY created_at DESC",
        [projectId],
      )
    ).map(appDto);
  }
  async createApplication(actor: Principal, projectId: string, name: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    const secretKey = randomBytes(32).toString("hex");
    const [r] = await this.db.query(
      "INSERT INTO applications(id,tenant_id,project_id,name,access_key,secret_enc) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        randomUUID(),
        actor.tenantId,
        projectId,
        name,
        randomBytes(16).toString("hex"),
        this.vault.encrypt(secretKey),
      ],
    );
    return { ...appDto(r), secretKey };
  }
  async revokeApplication(actor: Principal, projectId: string, id: string) {
    this.requireUser(actor);
    await this.project(actor, projectId);
    await this.db.query("UPDATE applications SET active=false WHERE id=$1 AND project_id=$2", [
      id,
      projectId,
    ]);
  }
}
