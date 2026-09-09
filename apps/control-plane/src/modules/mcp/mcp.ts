import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  compileMcpSchema,
  McpDescriptor,
  McpDiscovery,
  type McpFinish,
  type McpImport,
  McpJob,
  McpServer,
  type McpServerInput,
  type McpServerUpdate,
  type Principal,
  ReleaseSnapshot,
  Tool,
  z,
} from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import type { ExecutionContext } from "../../infrastructure/execution-context.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import type { Projects } from "../projects/index.ts";
import { requireUser } from "../projects/index.ts";

const date = (v: unknown) => new Date(String(v)).toISOString();
const serverDto = (r: Row) =>
  McpServer.parse({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    url: r.url,
    enabled: r.enabled,
    hasCredential: !!r.secret_enc,
    transport: "streamable-http",
    createdAt: date(r.created_at),
  });
const discoveryDto = (r: Row) =>
  McpDiscovery.parse({
    id: r.id,
    serverId: r.server_id,
    status: r.status,
    tools: r.tools,
    errorCode: r.error_code,
    createdAt: date(r.created_at),
    finishedAt: r.finished_at ? date(r.finished_at) : null,
  });
const toolDto = (r: Row) =>
  Tool.parse({
    ...(r.data as object),
    id: r.id,
    projectId: r.project_id,
    hasCredential: !!r.secret_enc,
    version: 1,
    createdAt: date(r.created_at),
  });

export class Mcp {
  constructor(readonly deps: ExecutionContext & { projects: Projects }) {}
  private async server(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.deps.db,
    lock = false,
  ) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT * FROM mcp_servers WHERE id=$1 AND project_id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id, projectId],
    );
    if (!r) throw notFound();
    return r;
  }
  async list(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    return (
      await this.deps.db.query(
        "SELECT * FROM mcp_servers WHERE project_id=$1 ORDER BY created_at DESC",
        [projectId],
      )
    ).map(serverDto);
  }
  async create(actor: Principal, projectId: string, input: z.infer<typeof McpServerInput>) {
    requireUser(actor);
    await this.deps.projects.get(actor, projectId);
    const url = new URL(input.url);
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
        "服务地址必须为 HTTP(S)，不能包含凭据、查询参数或片段",
      );
    const [r] = await this.deps.db.query(
      "INSERT INTO mcp_servers(id,tenant_id,project_id,name,url,secret_enc) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        randomUUID(),
        actor.tenantId,
        projectId,
        input.name,
        url.href,
        this.deps.vault.encrypt(input.bearerToken),
      ],
    );
    return serverDto(r);
  }
  async update(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof McpServerUpdate>,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const r = await this.server(actor, projectId, id, tx, true);
      const [updated] = await tx.query(
        "UPDATE mcp_servers SET enabled=$2,secret_enc=$3 WHERE id=$1 RETURNING *",
        [
          id,
          input.enabled ?? r.enabled,
          input.bearerToken === undefined
            ? r.secret_enc
            : this.deps.vault.encrypt(input.bearerToken),
        ],
      );
      if (input.enabled === false)
        await tx.query(
          "UPDATE mcp_discoveries SET status='cancelled',error_code='MCP_DISABLED',finished_at=clock_timestamp() WHERE server_id=$1 AND status IN ('queued','running')",
          [id],
        );
      return serverDto(updated);
    });
  }
  async discoveries(actor: Principal, projectId: string, id: string, input: PageInput = {}) {
    await this.server(actor, projectId, id);
    const page = cursorPage(["mcp-discoveries", actor.tenantId, projectId, id], input, 10);
    const rows = await this.deps.db.query(
      `SELECT d.*,${page.select("d")} FROM mcp_discoveries d WHERE d.server_id=$1
       AND ${page.where("d", 2)} ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,
      [id, ...page.values],
    );
    return page.result(rows, discoveryDto);
  }

  async discover(actor: Principal, projectId: string, id: string) {
    return this.deps.db.transaction(async (tx) => {
      const server = await this.server(actor, projectId, id, tx, true);
      if (!server.enabled) throw new ApiError(409, "MCP_DISABLED", "请先启用 MCP 服务");
      const [pending] = await tx.query(
        "SELECT * FROM mcp_discoveries WHERE server_id=$1 AND status IN ('queued','running')",
        [id],
      );
      if (pending) return discoveryDto(pending);
      const [r] = await tx.query(
        "INSERT INTO mcp_discoveries(id,server_id,runtime_id,status,deadline) VALUES($1,$2,$3,'queued',clock_timestamp()+interval '60 seconds') RETURNING *",
        [randomUUID(), id, this.deps.runtimeId],
      );
      return discoveryDto(r);
    });
  }
  async importTool(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof McpImport>,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const server = await this.server(actor, projectId, id, tx, true);
      if (!server.enabled) throw new ApiError(409, "MCP_DISABLED", "MCP 服务已停用");
      if (!input.confirmedReadOnly)
        throw new ApiError(400, "MCP_REVIEW_REQUIRED", "请确认工具仅执行只读操作");
      if (input.name === "knowledge_search")
        throw new ApiError(400, "RESERVED_TOOL_NAME", "名称由平台保留");
      const [d] = await tx.query(
        "SELECT * FROM mcp_discoveries WHERE id=$1 AND server_id=$2 AND status='succeeded'",
        [input.discoveryId, id],
      );
      if (!d) throw notFound();
      const descriptor = z
        .array(McpDescriptor)
        .parse(d.tools)
        .find((t) => t.name === input.remoteName);
      if (!descriptor) throw notFound();
      try {
        compileMcpSchema(descriptor.inputSchema);
        if (descriptor.outputSchema) compileMcpSchema(descriptor.outputSchema);
        if (descriptor.execution?.taskSupport === "required")
          throw new Error("MCP task is unsupported");
      } catch {
        throw new ApiError(
          400,
          "MCP_SCHEMA_UNSUPPORTED",
          "当前支持内联 object JSON Schema；引用、正则、format 和异步 task 待接入",
        );
      }
      const contractDigest = sha256(canonicalJson(descriptor));
      const [existing] = await tx.query(
        "SELECT r.* FROM mcp_imports i JOIN resources r ON r.id=i.tool_id WHERE i.server_id=$1 AND i.remote_name=$2 AND i.contract_digest=$3 AND i.platform_name=$4",
        [id, descriptor.name, contractDigest, input.name],
      );
      if (existing) return toolDto(existing);
      const payload = Tool.omit({
        id: true,
        projectId: true,
        hasCredential: true,
        version: true,
        createdAt: true,
      }).parse({
        name: input.name,
        description: descriptor.description.slice(0, 1000) || descriptor.name,
        kind: "mcp",
        url: server.url,
        inputSchema: descriptor.inputSchema,
        outputSchema: {
          type: "object",
          properties: { text: { type: "string" }, data: { type: "object" } },
          required: ["text"],
          additionalProperties: false,
        },
        mcp: { serverId: id, descriptor, contractDigest },
      });
      const [resource] = await tx.query(
        "INSERT INTO resources(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'tool',$4) RETURNING *",
        [randomUUID(), actor.tenantId, projectId, payload],
      );
      await tx.query(
        "INSERT INTO mcp_imports(server_id,remote_name,contract_digest,tool_id,discovery_id,reviewed_by,platform_name) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, descriptor.name, contractDigest, resource.id, input.discoveryId, actor.id, input.name],
      );
      return toolDto(resource);
    });
  }
  async claim() {
    return this.deps.db.transaction(async (tx) => {
      const [d] = await tx.query(
        "SELECT d.* FROM mcp_discoveries d JOIN mcp_servers s ON s.id=d.server_id WHERE d.runtime_id=$1 AND d.status='queued' AND d.deadline>clock_timestamp() AND s.enabled=true ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1",
        [this.deps.runtimeId],
      );
      if (!d) return null;
      const leaseToken = randomUUID();
      await tx.query(
        "UPDATE mcp_discoveries SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1",
        [d.id, leaseToken],
      );
      const [s] = await tx.query("SELECT * FROM mcp_servers WHERE id=$1", [d.server_id]);
      return McpJob.parse({
        id: d.id,
        serverId: s.id,
        leaseToken,
        url: s.url,
        bearerToken: this.deps.vault.decrypt(String(s.secret_enc)),
        deadline: new Date(String(d.deadline)).getTime(),
      });
    });
  }
  private async active(tx: Queryable, id: string, leaseToken: string) {
    // Lock the service first, matching disable/import, then evaluate wall time after locks.
    const [s] = await tx.query(
      "SELECT s.* FROM mcp_servers s JOIN mcp_discoveries d ON d.server_id=s.id WHERE d.id=$1 FOR SHARE OF s",
      [id],
    );
    const [d] = await tx.query(
      "SELECT * FROM mcp_discoveries WHERE id=$1 AND runtime_id=$2 FOR UPDATE",
      [id, this.deps.runtimeId],
    );
    const [clock] = await tx.query("SELECT clock_timestamp() AS current_time");
    const now = new Date(String(clock.current_time)).getTime();
    if (
      !s?.enabled ||
      d?.status !== "running" ||
      d.lease_token !== leaseToken ||
      new Date(String(d.lease_until)).getTime() <= now ||
      new Date(String(d.deadline)).getTime() <= now
    )
      throw new ApiError(409, "LEASE_EXPIRED", "MCP 发现任务已失效");
    return d;
  }
  async renew(id: string, leaseToken: string) {
    await this.deps.db.transaction(async (tx) => {
      await this.active(tx, id, leaseToken);
      await tx.query(
        "UPDATE mcp_discoveries SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1",
        [id],
      );
    });
  }
  async finish(id: string, input: z.infer<typeof McpFinish>) {
    await this.deps.db.transaction(async (tx) => {
      await this.active(tx, id, input.leaseToken);
      const tools = input.tools ?? [];
      if (
        input.status === "succeeded" &&
        (!input.tools ||
          new Set(tools.map((t) => t.name)).size !== tools.length ||
          JSON.stringify(tools).length > 200000)
      )
        throw new ApiError(400, "MCP_DISCOVERY_INVALID", "能力发现结果无效或超出预算");
      await tx.query(
        "UPDATE mcp_discoveries SET status=$2,tools=$3,error_code=$4,finished_at=clock_timestamp() WHERE id=$1",
        [
          id,
          input.status,
          JSON.stringify(input.status === "succeeded" ? tools : []),
          input.status === "succeeded" ? null : (input.errorCode ?? "MCP_CONNECTION_FAILED"),
        ],
      );
    });
  }
  async reap() {
    await this.deps.db.query(
      "UPDATE mcp_discoveries SET status='failed',error_code=CASE WHEN status='queued' THEN 'RUNTIME_UNAVAILABLE' ELSE 'TIMEOUT' END,finished_at=clock_timestamp() WHERE (status='queued' AND deadline<clock_timestamp()) OR (status='running' AND (deadline<clock_timestamp() OR lease_until<clock_timestamp()))",
    );
  }
  async authorize(runId: string, leaseToken: string, toolId: string) {
    return this.deps.db.transaction(async (tx) => {
      const [run] = await tx.query("SELECT * FROM runs WHERE id=$1 AND runtime_id=$2 FOR UPDATE", [
        runId,
        this.deps.runtimeId,
      ]);
      if (!run) throw notFound();
      const [release] = await tx.query(
        "SELECT snapshot FROM releases WHERE id=$1 AND project_id=$2",
        [run.release_id, run.project_id],
      );
      const tool = ReleaseSnapshot.parse(release.snapshot).tools.find(
        (t) => t.id === toolId && t.kind === "mcp",
      );
      if (!tool?.mcp) throw new ApiError(403, "MCP_AUTH_DENIED", "工具未绑定到本次发布");
      const [server] = await tx.query(
        "SELECT s.* FROM mcp_servers s JOIN mcp_imports i ON i.server_id=s.id WHERE s.id=$1 AND s.project_id=$2 AND s.tenant_id=$3 AND i.tool_id=$4 AND i.contract_digest=$5 FOR SHARE OF s",
        [tool.mcp.serverId, run.project_id, run.tenant_id, toolId, tool.mcp.contractDigest],
      );
      if (!server?.enabled) throw new ApiError(409, "MCP_AUTH_DENIED", "MCP 服务已停用或绑定失效");
      if (String(run.entry).startsWith("app:")) {
        const [application] = await tx.query(
          "SELECT active FROM applications WHERE id=$1 AND project_id=$2",
          [run.actor_id, run.project_id],
        );
        if (!application?.active) throw new ApiError(403, "MCP_AUTH_DENIED", "业务应用已停用");
      }
      const [clock] = await tx.query("SELECT clock_timestamp() AS current_time");
      const now = new Date(String(clock.current_time)).getTime();
      if (
        run.status !== "running" ||
        run.cancel_requested ||
        run.lease_token !== leaseToken ||
        new Date(String(run.lease_until)).getTime() <= now ||
        new Date(String(run.deadline)).getTime() <= now
      )
        throw new ApiError(409, "LEASE_EXPIRED", "运行租约已失效或运行已取消");
      return {
        url: String(server.url),
        bearerToken: this.deps.vault.decrypt(String(server.secret_enc)),
      };
    });
  }
}
