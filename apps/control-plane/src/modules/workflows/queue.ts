import { randomUUID } from "node:crypto";
import {
  assertWorkflowValue,
  canonicalJson,
  ExecutionJob,
  evaluateCondition,
  Model,
  type Principal,
  type SkillAccessRequest,
  SkillErrorCode,
  type VectorQuery,
  validateWorkflowProposal,
  WorkflowCandidate,
  type WorkflowNodeFinish,
  WorkflowNodeRun,
  type WorkflowRuntimeFinish,
  WorkflowRuntimeJob,
  WorkflowSnapshot,
  workflowNodeInput,
  type z,
} from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import type { ExecutionContext } from "../../infrastructure/execution-context.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { requireUser } from "../projects/index.ts";
import { executionCredentials, resourceCredential } from "../resources/index.ts";
import type { Skills } from "../skills/index.ts";
import { type Workflows, workflowDate } from "./workflows.ts";

const knownErrors = new Set([
  ...SkillErrorCode.options,
  "WORKFLOW_FAILED",
  "WORKFLOW_INVALID",
  "WORKFLOW_NODE_FAILED",
  "WORKFLOW_VALUE_INVALID",
  "WORKFLOW_VALUE_LIMIT",
  "WORKFLOW_REFERENCE_MISSING",
  "WORKFLOW_BRANCH_INVALID",
  "CANDIDATE_INVALID",
  "MODEL_ERROR",
  "TOOL_INPUT_INVALID",
  "TOOL_OUTPUT_INVALID",
  "TOOL_HTTP_ERROR",
  "TOOL_EMPTY_RESPONSE",
  "TOOL_RESULT_TOO_LARGE",
  "MCP_CONNECTION_FAILED",
  "MCP_TIMEOUT",
  "MCP_CONTRACT_CHANGED",
  "MCP_INPUT_INVALID",
  "MCP_RESULT_INVALID",
  "MCP_CONTENT_UNSUPPORTED",
  "MCP_TOOL_ERROR",
  "MCP_SCHEMA_UNSUPPORTED",
  "MCP_AUTH_DENIED",
  "MCP_LIMIT",
  "KNOWLEDGE_UNAVAILABLE",
  "TIMEOUT",
  "CANCELLED",
  "LEASE_EXPIRED",
  "APPLICATION_REVOKED",
]);
const safeError = (code?: string) => (code && knownErrors.has(code) ? code : "WORKFLOW_FAILED");
export class WorkflowQueue {
  constructor(
    readonly workflows: Workflows,
    readonly knowledge: Knowledge,
    readonly execution: ExecutionContext,
    readonly skills: Skills,
  ) {}
  get db() {
    return this.execution.db;
  }
  private async live(tx: Queryable, job: Row, leaseToken: string, access = true) {
    const [clock] = await tx.query("SELECT clock_timestamp() AS t");
    const now = new Date(String(clock.t)).getTime();
    if (
      job.status !== "running" ||
      job.lease_token !== leaseToken ||
      new Date(String(job.lease_until)).getTime() <= now ||
      new Date(String(job.deadline)).getTime() <= now
    )
      throw new ApiError(409, "LEASE_EXPIRED", "流程租约已失效或运行已结束");
    if (access && String(job.entry).startsWith("app:")) {
      const [app] = await tx.query(
        "SELECT active FROM applications WHERE id=$1 AND project_id=$2",
        [job.actor_id, job.project_id],
      );
      if (!app?.active) throw new ApiError(403, "APPLICATION_REVOKED", "业务应用已停用");
    }
  }
  private async active(tx: Queryable, id: string, leaseToken: string, access = true) {
    const [job] = await tx.query(
      "SELECT * FROM workflow_jobs WHERE id=$1 AND runtime_id=$2 FOR UPDATE",
      [id, this.execution.runtimeId],
    );
    if (!job) throw notFound();
    await this.live(tx, job, leaseToken, access);
    return job;
  }
  private secret(tx: Queryable, job: Row, id: string, kind: "tool" | "model") {
    return resourceCredential(
      tx,
      this.execution.vault,
      { tenantId: String(job.tenant_id), projectId: String(job.project_id) },
      id,
      kind,
    );
  }
  async claim() {
    return this.db.transaction(async (tx) => {
      await tx.query("UPDATE runtimes SET last_seen_at=now() WHERE id=$1", [
        this.execution.runtimeId,
      ]);
      const [job] = await tx.query(
        "SELECT * FROM workflow_jobs WHERE runtime_id=$1 AND status='queued' AND deadline>clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [this.execution.runtimeId],
      );
      if (!job) return null;
      const leaseToken = randomUUID(),
        deadline = new Date(String(job.deadline)).getTime();
      await tx.query(
        "UPDATE workflow_jobs SET status='running',lease_token=$1,lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$2",
        [leaseToken, job.id],
      );
      if (job.kind === "execute") {
        const snapshot = WorkflowSnapshot.parse(job.snapshot);
        for (const node of snapshot.definition.nodes)
          await tx.query(
            "INSERT INTO workflow_node_runs(job_id,node_id,label,type) VALUES($1,$2,$3,$4)",
            [job.id, node.id, node.label, node.type],
          );
        return WorkflowRuntimeJob.parse({
          kind: "execute",
          id: job.id,
          leaseToken,
          deadline,
          snapshot,
          input: job.input,
        });
      }
      const snapshot = job.snapshot as { model: unknown; definition: unknown; catalog: unknown };
      const model = Model.parse(snapshot.model);
      return WorkflowRuntimeJob.parse({
        kind: "generate",
        id: job.id,
        leaseToken,
        deadline,
        model,
        definition: snapshot.definition,
        catalog: snapshot.catalog,
        intent: (job.input as { intent: string }).intent,
        apiKey: await this.secret(tx, job, model.id, "model"),
      });
    });
  }
  async renew(id: string, leaseToken: string) {
    return this.db.transaction(async (tx) => {
      await this.active(tx, id, leaseToken);
      await tx.query(
        "UPDATE workflow_jobs SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1",
        [id],
      );
      await tx.query("UPDATE runtimes SET last_seen_at=now() WHERE id=$1", [
        this.execution.runtimeId,
      ]);
      return { ok: true };
    });
  }
  async nodes(actor: Principal, projectId: string, id: string) {
    await this.workflows.ownedJob(actor, projectId, id, "execute");
    return (
      await this.db.query(
        "SELECT * FROM workflow_node_runs WHERE job_id=$1 ORDER BY started_at NULLS LAST,node_id",
        [id],
      )
    ).map((r) =>
      WorkflowNodeRun.parse({
        nodeId: r.node_id,
        label: r.label,
        type: r.type,
        status: r.status,
        input: r.input,
        output: r.output,
        errorCode: r.error_code,
        startedAt: r.started_at ? workflowDate(r.started_at) : null,
        finishedAt: r.finished_at ? workflowDate(r.finished_at) : null,
      }),
    );
  }
  private async context(tx: Queryable, job: Row, nodeId: string) {
    if (job.kind !== "execute") throw notFound();
    const snapshot = WorkflowSnapshot.parse(job.snapshot);
    const node = snapshot.definition.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound();
    const rows = await tx.query("SELECT * FROM workflow_node_runs WHERE job_id=$1", [job.id]);
    const current = rows.find((r) => r.node_id === nodeId);
    if (!current) throw notFound();
    const outputs = Object.fromEntries(
      rows.filter((r) => r.status === "succeeded").map((r) => [String(r.node_id), r.output]),
    );
    return { snapshot, node, rows, current, outputs };
  }
  async startNode(id: string, nodeId: string, leaseToken: string) {
    return this.db.transaction(async (tx) => {
      const job = await this.active(tx, id, leaseToken);
      const { snapshot, node, rows, current, outputs } = await this.context(tx, job, nodeId);
      if (
        current.status !== "pending" ||
        rows.some((r) => r.status === "running" || r.status === "failed")
      )
        throw new ApiError(409, "NODE_STATE", "节点不可重复执行或前序节点未完成");
      const edge = snapshot.definition.edges.find((e) => e.target === nodeId);
      if (edge) {
        const parent = rows.find((r) => r.node_id === edge.source);
        if (
          parent?.status !== "succeeded" ||
          (edge.port !== "out" &&
            (edge.port === "true") !== (parent.output as { matched: boolean })?.matched)
        )
          throw new ApiError(409, "NODE_PATH", "节点不在本次选中的执行路径");
      } else if (node.type !== "start") throw new ApiError(409, "NODE_PATH", "缺少前驱节点");
      const input = workflowNodeInput(node, job.input, outputs);
      const capability = snapshot.catalog.find(
        (c) =>
          (node.type === "tool" && c.kind === "tool" && c.id === node.toolId) ||
          (node.type === "agent" && c.kind === "agent" && c.id === node.releaseId),
      );
      if (capability) assertWorkflowValue(capability.inputSchema, input);
      let binding: Record<string, unknown> = {};
      if (node.type === "tool") {
        const tool = snapshot.tools.find((t) => t.id === node.toolId);
        if (!tool) throw notFound();
        await this.workflows.checkTool(tx, String(job.project_id), String(job.tenant_id), tool);
        binding = {
          tool,
          token: tool.kind === "mcp" ? "" : await this.secret(tx, job, tool.id, "tool"),
        };
      }
      if (node.type === "agent") {
        const release = snapshot.agents.find((a) => a.id === node.releaseId);
        if (!release) throw notFound();
        for (const tool of release.snapshot.tools)
          await this.workflows.checkTool(tx, String(job.project_id), String(job.tenant_id), tool);
        binding = {
          agentJob: ExecutionJob.parse({
            runId: id,
            leaseToken,
            snapshot: release.snapshot,
            messages: [
              {
                id: `workflow-${nodeId}`,
                role: "user",
                parts: [{ type: "text", text: input.prompt }],
              },
            ],
            credentials: await executionCredentials(
              tx,
              this.execution.vault,
              { tenantId: String(job.tenant_id), projectId: String(job.project_id) },
              release.snapshot,
            ),
            deadline: new Date(String(job.deadline)).getTime(),
          }),
        };
      }
      await this.live(tx, job, leaseToken);
      await tx.query(
        "UPDATE workflow_node_runs SET status='running',input=$1,started_at=clock_timestamp() WHERE job_id=$2 AND node_id=$3",
        [input, id, nodeId],
      );
      return { input, ...binding };
    });
  }
  async finishNode(id: string, nodeId: string, input: z.infer<typeof WorkflowNodeFinish>) {
    await this.db.transaction(async (tx) => {
      const job = await this.active(tx, id, input.leaseToken, input.status === "succeeded");
      const { snapshot, node, current, outputs } = await this.context(tx, job, nodeId);
      if (current.status !== "running")
        throw new ApiError(409, "NODE_STATE", "节点尚未执行或已结束");
      if (input.status === "succeeded") {
        const capability = snapshot.catalog.find(
          (c) =>
            (node.type === "tool" && c.kind === "tool" && c.id === node.toolId) ||
            (node.type === "agent" && c.kind === "agent" && c.id === node.releaseId),
        );
        assertWorkflowValue(
          node.type === "end"
            ? snapshot.definition.outputSchema
            : (capability?.outputSchema ?? { type: "object" }),
          input.output,
        );
        if (!capability) {
          const expected =
            node.type === "condition"
              ? { matched: evaluateCondition(node, job.input, outputs) }
              : current.input;
          if (canonicalJson(input.output) !== canonicalJson(expected))
            throw new ApiError(409, "NODE_OUTPUT", "节点结果不符合固定映射或条件");
        }
      }
      await tx.query(
        "UPDATE workflow_node_runs SET status=$1,output=$2,error_code=$3,finished_at=clock_timestamp() WHERE job_id=$4 AND node_id=$5",
        [
          input.status,
          input.status === "succeeded" ? input.output : null,
          input.status === "failed" ? safeError(input.errorCode) : null,
          id,
          nodeId,
        ],
      );
    });
  }
  private async runningNode(tx: Queryable, id: string, nodeId: string, leaseToken: string) {
    const job = await this.active(tx, id, leaseToken);
    const context = await this.context(tx, job, nodeId);
    if (context.current.status !== "running") throw new ApiError(409, "NODE_STATE", "节点已停止");
    return { ...context, job };
  }
  async skillAccess(id: string, nodeId: string, input: SkillAccessRequest) {
    return this.db.transaction(async (tx) => {
      const { job, snapshot, node } = await this.runningNode(tx, id, nodeId, input.leaseToken);
      const agent =
        node.type === "agent" ? snapshot.agents.find((a) => a.id === node.releaseId) : undefined;
      if (!agent) throw new ApiError(403, "SKILL_ACCESS_DENIED", "该节点未绑定 Skill");
      return this.skills.access(
        tx,
        { tenantId: String(job.tenant_id), projectId: String(job.project_id) },
        agent.snapshot,
        input,
      );
    });
  }
  async authorizeMcp(id: string, nodeId: string, leaseToken: string, toolId: string) {
    return this.db.transaction(async (tx) => {
      const { job, snapshot, node } = await this.runningNode(tx, id, nodeId, leaseToken);
      const tools =
        node.type === "agent"
          ? (snapshot.agents.find((a) => a.id === node.releaseId)?.snapshot.tools ?? [])
          : node.type === "tool"
            ? snapshot.tools.filter((t) => t.id === node.toolId)
            : [];
      const tool = tools.find((t) => t.id === toolId && t.kind === "mcp");
      if (!tool?.mcp) throw new ApiError(403, "MCP_AUTH_DENIED", "MCP 工具未绑定到该节点");
      const [server] = await tx.query(
        "SELECT s.* FROM mcp_servers s JOIN mcp_imports i ON i.server_id=s.id WHERE s.id=$1 AND s.project_id=$2 AND s.tenant_id=$3 AND i.tool_id=$4 AND i.contract_digest=$5 FOR SHARE OF s",
        [tool.mcp.serverId, job.project_id, job.tenant_id, toolId, tool.mcp.contractDigest],
      );
      if (!server?.enabled) throw new ApiError(409, "MCP_AUTH_DENIED", "MCP 服务已停用");
      await this.live(tx, job, leaseToken);
      return {
        url: String(server.url),
        bearerToken: this.execution.vault.decrypt(String(server.secret_enc)),
      };
    });
  }
  async queryKnowledge(id: string, nodeId: string, input: z.infer<typeof VectorQuery>) {
    return this.db.transaction(async (tx) => {
      const { job, snapshot, node } = await this.runningNode(tx, id, nodeId, input.leaseToken);
      if (
        node.type !== "agent" ||
        !snapshot.agents
          .find((a) => a.id === node.releaseId)
          ?.snapshot.knowledgeBases.some((k) => k.id === input.knowledgeBaseId)
      )
        throw notFound();
      const hits = await this.knowledge.nearest(tx, input.knowledgeBaseId, input.vector);
      await this.live(tx, job, input.leaseToken);
      return hits;
    });
  }
  async finish(id: string, input: z.infer<typeof WorkflowRuntimeFinish>) {
    await this.db.transaction(async (tx) => {
      const job = await this.active(tx, id, input.leaseToken, input.status === "succeeded");
      let status: string = input.status,
        errorCode = input.status === "succeeded" ? null : safeError(input.errorCode);
      let output: unknown = null,
        candidate: unknown = null,
        issues: unknown[] = [];
      if (job.kind === "execute" && status === "succeeded") {
        const rows = await tx.query("SELECT * FROM workflow_node_runs WHERE job_id=$1", [id]);
        const ends = rows.filter((r) => r.type === "end" && r.status === "succeeded");
        if (
          ends.length !== 1 ||
          rows.some((r) => ["running", "failed", "cancelled"].includes(String(r.status)))
        )
          throw new ApiError(409, "WORKFLOW_INCOMPLETE", "流程尚未成功到达结束节点");
        output = ends[0].output;
        assertWorkflowValue(WorkflowSnapshot.parse(job.snapshot).definition.outputSchema, output);
      }
      if (job.kind === "generate" && status === "succeeded") {
        candidate = WorkflowCandidate.parse(input.candidate);
        const typed = WorkflowCandidate.parse(candidate);
        const base = job.snapshot as Pick<WorkflowSnapshot, "definition" | "catalog">;
        issues = validateWorkflowProposal(typed.definition, base.definition, base.catalog);
        if (issues.length) {
          status = "failed";
          errorCode = "CANDIDATE_INVALID";
        }
      }
      await tx.query(
        "UPDATE workflow_jobs SET status=$1,output=$2,candidate=$3,issues=$4,attempts=$5,error_code=$6,finished_at=clock_timestamp() WHERE id=$7",
        [status, output, candidate, JSON.stringify(issues), input.attempts ?? 0, errorCode, id],
      );
      await this.closeNodes(tx, id, status, errorCode);
    });
  }
  private async closeNodes(tx: Queryable, id: string, status: string, errorCode: string | null) {
    await tx.query(
      "UPDATE workflow_node_runs SET status=CASE WHEN status='pending' THEN 'skipped' ELSE $2 END,error_code=CASE WHEN status='pending' THEN NULL ELSE $3 END,finished_at=clock_timestamp() WHERE job_id=$1 AND status IN ('pending','running')",
      [id, status === "cancelled" ? "cancelled" : "failed", errorCode],
    );
  }
  async cancel(actor: Principal, projectId: string, id: string, kind: "execute" | "generate") {
    if (kind === "generate") requireUser(actor);
    await this.db.transaction(async (tx) => {
      const job = await this.workflows.ownedJob(actor, projectId, id, kind, tx, true);
      if (!["queued", "running"].includes(String(job.status))) return;
      await tx.query(
        "UPDATE workflow_jobs SET status='cancelled',error_code='CANCELLED',finished_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await this.closeNodes(tx, id, "cancelled", "CANCELLED");
    });
  }
  async reap() {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query(
        "UPDATE workflow_jobs j SET status='failed',error_code=CASE WHEN entry LIKE 'app:%' AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.id=j.actor_id AND a.active) THEN 'APPLICATION_REVOKED' WHEN j.status='queued' THEN 'RUNTIME_UNAVAILABLE' ELSE 'RUNTIME_LOST' END,finished_at=clock_timestamp() WHERE status IN ('queued','running') AND (deadline<clock_timestamp() OR (status='running' AND lease_until<clock_timestamp()) OR (entry LIKE 'app:%' AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.id=j.actor_id AND a.active))) RETURNING id,error_code",
      );
      for (const r of rows) await this.closeNodes(tx, String(r.id), "failed", String(r.error_code));
    });
  }
}
