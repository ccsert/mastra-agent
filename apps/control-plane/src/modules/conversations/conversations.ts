import { randomUUID } from "node:crypto";
import { Conversation, type Principal, Run, RunEvent } from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { date, text } from "../../infrastructure/records.ts";
import type { Projects } from "../projects/index.ts";
import type { Resources } from "../resources/index.ts";

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
export class Conversations {
  constructor(
    private readonly db: Database,
    private readonly projects: Projects,
    private readonly resources: Resources,
    private readonly runtimeId: string,
  ) {}
  async list(actor: Principal, projectId: string) {
    await this.projects.get(actor, projectId);
    return (
      await this.db.query(
        "SELECT c.*,r.version FROM conversations c JOIN releases r ON r.id=c.release_id WHERE c.project_id=$1 AND c.actor_id=$2 AND c.entry=$3 ORDER BY c.created_at DESC",
        [projectId, actor.id, actor.entry],
      )
    ).map(conversationDto);
  }
  async get(
    actor: Principal,
    projectId: string,
    id: string,
    tx: Queryable = this.db,
    lock = false,
  ) {
    await this.projects.get(actor, projectId, tx);
    const [r] = await tx.query(
      `SELECT c.*,r.version FROM conversations c JOIN releases r ON r.id=c.release_id WHERE c.id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.entry=$4 ${lock ? "FOR UPDATE OF c" : ""}`,
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return conversationDto(r);
  }
  async create(actor: Principal, projectId: string, agentId: string, title: string) {
    const agent = await this.resources.get(actor, projectId, agentId, "agent");
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
    return this.get(actor, projectId, id);
  }
  async messages(actor: Principal, projectId: string, conversationId: string) {
    await this.get(actor, projectId, conversationId);
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
      const conversation = await this.get(actor, projectId, conversationId, tx, true),
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
    await this.projects.get(actor, projectId);
    const [r] = await this.db.query(
      "SELECT q.*,r.version,r.snapshot->'agent'->>'name' AS agent_name FROM runs q JOIN releases r ON q.release_id=r.id WHERE q.id=$1 AND q.project_id=$2 AND q.actor_id=$3 AND q.entry=$4",
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return runDto(r);
  }
  async runs(actor: Principal, projectId: string, input: PageInput = {}) {
    await this.projects.get(actor, projectId);
    const page = cursorPage(["runs", actor.tenantId, projectId, actor.id, actor.entry], input);
    const rows = await this.db.query(
      `SELECT q.*,r.version,r.snapshot->'agent'->>'name' AS agent_name,${page.select("q")}
       FROM runs q JOIN releases r ON q.release_id=r.id
       WHERE q.project_id=$1 AND q.actor_id=$2 AND q.entry=$3 AND ${page.where("q", 4)}
       ORDER BY q.created_at DESC,q.id DESC LIMIT $6`,
      [projectId, actor.id, actor.entry, ...page.values],
    );
    return page.result(rows, runDto);
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
}
