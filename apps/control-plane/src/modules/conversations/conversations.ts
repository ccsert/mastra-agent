import { randomUUID } from "node:crypto";
import { type Principal, ReleaseSnapshot, RunEvent, SkillSelection } from "@platform/contracts";
import type { Database, Queryable } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { date, text } from "../../infrastructure/records.ts";
import type { Projects } from "../projects/index.ts";
import type { Resources } from "../resources/index.ts";
import type { Skills } from "../skills/index.ts";

import { conversationDto, restoreLegacyInputs, runDto, selectedSkills } from "./records.ts";
import { listConversationSummaries, readConversationTrace } from "./traces.ts";

export class Conversations {
  constructor(
    private readonly db: Database,
    private readonly projects: Projects,
    private readonly resources: Resources,
    private readonly runtimeId: string,
    private readonly skills: Skills,
  ) {}
  private async snapshot(tx: Queryable, projectId: string, releaseId: string) {
    const [release] = await tx.query(
      "SELECT snapshot FROM releases WHERE id=$1 AND project_id=$2",
      [releaseId, projectId],
    );
    if (!release) throw notFound();
    return ReleaseSnapshot.parse(release.snapshot);
  }
  async capabilities(actor: Principal, projectId: string, id: string) {
    const conversation = await this.get(actor, projectId, id);
    const snapshot = await this.snapshot(this.db, projectId, conversation.releaseId);
    const enabled = await this.skills.availability(
      this.db,
      { projectId, tenantId: actor.tenantId },
      snapshot.skills.map((s) => s.id),
    );
    return {
      skills: snapshot.skills.map((s) => ({
        versionId: s.id,
        name: s.name,
        version: s.version,
        description: s.description,
        enabled: enabled.has(s.id),
      })),
    };
  }
  async list(actor: Principal, projectId: string, input: PageInput = {}) {
    await this.projects.get(actor, projectId);
    const page = cursorPage(
      ["conversations", actor.tenantId, projectId, actor.id, actor.entry],
      input,
    );
    const rows = await this.db.query(
      `SELECT c.id,c.project_id,c.agent_id,c.release_id,c.title,c.created_at,r.version,${page.select("c")}
       FROM conversations c JOIN releases r ON r.id=c.release_id AND r.project_id=c.project_id
       WHERE c.project_id=$1 AND c.tenant_id=$2 AND c.actor_id=$3 AND c.entry=$4
         AND ${page.where("c", 5)} ORDER BY c.created_at DESC,c.id DESC LIMIT $7`,
      [projectId, actor.tenantId, actor.id, actor.entry, ...page.values],
    );
    return page.result(rows, conversationDto);
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
    skillVersionIds: string[] = [],
  ) {
    const selection = [...new Set(SkillSelection.parse(skillVersionIds))].sort();
    const runId = await this.db.transaction(async (tx) => {
      const conversation = await this.get(actor, projectId, conversationId, tx, true),
        hash = sha256(JSON.stringify({ input, skillVersionIds: selection }));
      const [prior] = await tx.query(
        "SELECT id,input_hash,input_text FROM runs WHERE conversation_id=$1 AND request_id=$2",
        [conversationId, requestId],
      );
      if (prior) {
        // Before migration 8 the hash covered plain text only; those runs have no explicit selection.
        const legacyMatch =
          prior.input_text === null && !selection.length && prior.input_hash === sha256(input);
        if (prior.input_hash !== hash && !legacyMatch)
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容");
        return text(prior, "id");
      }
      const snapshot = await this.snapshot(tx, projectId, conversation.releaseId);
      const enabled = await this.skills.availability(
        tx,
        { projectId, tenantId: actor.tenantId },
        selection,
      );
      if (selection.some((id) => !enabled.has(id) || !snapshot.skills.some((s) => s.id === id)))
        throw new ApiError(
          403,
          "SKILL_ACCESS_DENIED",
          "只能指定当前会话发布版本已绑定且仍启用的 Skill",
        );
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
        "INSERT INTO runs(id,tenant_id,project_id,actor_id,entry,conversation_id,release_id,request_id,input_hash,runtime_id,status,deadline,input_text,skill_version_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',now()+interval '3 minutes',$11,$12)",
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
          input,
          JSON.stringify(selection),
        ],
      );
      await tx.query("INSERT INTO messages(id,conversation_id,data) VALUES($1,$2,$3)", [
        messageId,
        conversationId,
        {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: input }],
          metadata: { runId: id, selectedSkills: selectedSkills(snapshot, selection) },
        },
      ]);
      return id;
    });
    return this.run(actor, projectId, runId);
  }
  async run(actor: Principal, projectId: string, id: string) {
    await this.projects.get(actor, projectId);
    const [r] = await this.db.query(
      "SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name FROM runs q JOIN releases r ON q.release_id=r.id WHERE q.id=$1 AND q.project_id=$2 AND q.actor_id=$3 AND q.entry=$4",
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    return runDto((await restoreLegacyInputs(this.db, [r]))[0]);
  }
  async runs(actor: Principal, projectId: string, input: PageInput = {}, conversationId?: string) {
    await this.projects.get(actor, projectId);
    if (conversationId) await this.get(actor, projectId, conversationId);
    const page = cursorPage(
      ["runs", actor.tenantId, projectId, actor.id, actor.entry, conversationId ?? ""],
      input,
    );
    const rows = await this.db.query(
      `SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name,${page.select("q")}
       FROM runs q JOIN releases r ON q.release_id=r.id
       WHERE q.project_id=$1 AND q.actor_id=$2 AND q.entry=$3 AND ${page.where("q", 4)} AND ($7::uuid IS NULL OR q.conversation_id=$7)
       ORDER BY q.created_at DESC,q.id DESC LIMIT $6`,
      [projectId, actor.id, actor.entry, ...page.values, conversationId ?? null],
    );
    return page.result(await restoreLegacyInputs(this.db, rows), runDto);
  }
  async trace(
    actor: Principal,
    projectId: string,
    id: string,
    query: { before?: number; limit?: number } = {},
  ) {
    await this.get(actor, projectId, id);
    return readConversationTrace(this.db, id, query);
  }
  async summaries(actor: Principal, projectId: string, input: PageInput = {}) {
    await this.projects.get(actor, projectId);
    return listConversationSummaries(this.db, actor, projectId, input);
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
