import { randomUUID } from "node:crypto";
import {
  ConversationSession,
  Id,
  Message,
  type Principal,
  ReleaseSnapshot,
  SkillSelection,
  type TaskFeedbackInput,
  TaskStateInput,
  z,
} from "@platform/contracts";
import type { Database, Queryable } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { text } from "../../infrastructure/records.ts";
import type { Projects } from "../projects/index.ts";
import type { Resources } from "../resources/index.ts";
import type { Skills } from "../skills/index.ts";
import { compactTranscript, conversationContext, modelHistory } from "./context.ts";
import { feedbackDto, saveFeedback } from "./feedback.ts";
import { interruptedMessage } from "./history.ts";
import {
  conversationDto,
  conversationTitle,
  restoreLegacyInputs,
  runDto,
  runEventDto,
  selectedSkills,
} from "./records.ts";
import { listConversationSummaries, readConversationTrace } from "./traces.ts";
import { projectRunWorkspace } from "./workspace.ts";

export class Conversations {
  async feedback(
    actor: Principal,
    projectId: string,
    id: string,
    input: z.infer<typeof TaskFeedbackInput>,
  ) {
    await this.run(actor, projectId, id);
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query(
        "SELECT * FROM runs WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND entry=$4 FOR UPDATE",
        [id, projectId, actor.id, actor.entry],
      );
      if (!run) throw notFound();
      return saveFeedback(tx, run, input);
    });
  }
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
  async list(
    actor: Principal,
    projectId: string,
    input: PageInput = {},
    filter: { pinned?: boolean } = {},
  ) {
    const access = await this.projects.access.project(actor, projectId);
    const page = cursorPage(
      ["conversations", actor.tenantId, projectId, actor.id, actor.entry],
      input,
    );
    const rows = await this.db.query(
      `SELECT c.id,c.project_id,c.agent_id,c.release_id,c.title,c.created_at,c.pinned_at,r.version,${page.select("c")}
       FROM conversations c JOIN releases r ON r.id=c.release_id AND r.project_id=c.project_id
       WHERE c.project_id=$1 AND c.tenant_id=$2 AND c.actor_id=$3 AND c.entry=$4
         AND (r.kind='published' OR $8::boolean)
         AND NOT EXISTS (SELECT 1 FROM platform_assistant_sessions s WHERE s.conversation_id=c.id)
         AND EXISTS (SELECT 1 FROM runs x WHERE x.conversation_id=c.id)
         AND ($9::boolean IS NOT TRUE OR c.pinned_at IS NOT NULL)
         AND ${page.where("c", 5)} ORDER BY c.created_at DESC,c.id DESC LIMIT $7`,
      [
        projectId,
        actor.tenantId,
        actor.id,
        actor.entry,
        ...page.values,
        access.permissions.includes("agent.edit"),
        filter.pinned === true,
      ],
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
    if (Number(r.version) === 0)
      await this.projects.access.require(actor, projectId, "agent.edit", tx);
    return conversationDto(r);
  }
  async create(actor: Principal, projectId: string, agentId: string, title: string) {
    await this.projects.access.require(actor, projectId, "agent.run");
    const agent = await this.resources.get(actor, projectId, agentId, "agent");
    if (!agent.current_release_id) throw new ApiError(409, "AGENT_NOT_PUBLISHED", "请先发布 Agent");
    // Reuse the unused session for this agent so repeated "对话" never piles up empty rows.
    const [existing] = await this.db.query(
      `SELECT c.id FROM conversations c
       WHERE c.project_id=$1 AND c.actor_id=$2 AND c.entry=$3 AND c.agent_id=$4
         AND EXISTS (SELECT 1 FROM releases r WHERE r.id=c.release_id AND r.kind='published')
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id=c.id)
       ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,
      [projectId, actor.id, actor.entry, agentId],
    );
    if (existing) {
      // Reset a reused placeholder to the requested title so the first message names it.
      const id = text(existing, "id");
      await this.db.query("UPDATE conversations SET release_id=$1, title=$2 WHERE id=$3", [
        agent.current_release_id,
        title,
        id,
      ]);
      return this.get(actor, projectId, id);
    }
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
  async context(actor: Principal, projectId: string, id: string) {
    await this.get(actor, projectId, id);
    return conversationContext(this.db, id);
  }
  async reset(actor: Principal, projectId: string, id: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const source = await this.get(actor, projectId, id, tx, true);
      const [assistant] = await tx.query(
        "SELECT context FROM platform_assistant_sessions WHERE conversation_id=$1 AND actor_id=$2",
        [id, actor.id],
      );
      await this.projects.access.require(
        actor,
        projectId,
        assistant ? "project.read" : "agent.run",
        tx,
      );
      const [prior] = await tx.query(
        "SELECT conversation_id FROM conversation_resets WHERE source_id=$1 AND request_id=$2",
        [id, requestId],
      );
      if (prior) return this.get(actor, projectId, String(prior.conversation_id), tx);
      const [active] = await tx.query(
        "SELECT id FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
        [id],
      );
      if (active) throw new ApiError(409, "CONVERSATION_BUSY", "请先停止当前任务，再开启干净会话");
      const nextId = randomUUID();
      await tx.query(
        "INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title) VALUES($1,$2,$3,$4,$5,$6,$7,'新会话')",
        [
          nextId,
          actor.tenantId,
          projectId,
          actor.id,
          actor.entry,
          source.agentId,
          source.releaseId,
        ],
      );
      if (assistant)
        await tx.query(
          "INSERT INTO platform_assistant_sessions(conversation_id,request_id,actor_id,project_id,context) VALUES($1,$2,$3,$4,$5)",
          [nextId, randomUUID(), actor.id, projectId, assistant.context],
        );
      await tx.query(
        "INSERT INTO conversation_resets(source_id,request_id,conversation_id) VALUES($1,$2,$3)",
        [id, requestId, nextId],
      );
      return this.get(actor, projectId, nextId, tx);
    });
  }
  async messages(actor: Principal, projectId: string, conversationId: string) {
    await this.get(actor, projectId, conversationId);
    return (
      await this.db.query("SELECT data FROM messages WHERE conversation_id=$1 ORDER BY position", [
        conversationId,
      ])
    ).map((r) => r.data);
  }
  async session(actor: Principal, projectId: string, id: string) {
    await this.get(actor, projectId, id);
    // One MVCC snapshot prevents a finishing run from falling between the history
    // and active-run reads. A just-finished response can still be replayed safely.
    const [row] = await this.db.query(
      `SELECT
        COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM messages WHERE conversation_id=c.id),'[]') AS messages,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'errorCode',r.error_code)) FROM runs r WHERE r.conversation_id=c.id AND r.status IN ('failed','cancelled')),'[]') AS interrupted,
        (SELECT jsonb_build_object('id',r.id,'status',r.status) FROM runs r
          WHERE r.conversation_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS "resumeRun"
       FROM conversations c WHERE c.id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.entry=$4`,
      [id, projectId, actor.id, actor.entry],
    );
    if (!row) throw notFound();
    const session = ConversationSession.parse(row);
    const interrupted = row.interrupted as {
      id: string;
      status: "failed" | "cancelled";
      errorCode: string | null;
    }[];
    for (const run of interrupted) {
      const userIndex = session.messages.findIndex(
        (m) => m.role === "user" && m.metadata?.runId === run.id,
      );
      if (
        userIndex < 0 ||
        session.messages.some((m) => m.role === "assistant" && m.metadata?.runId === run.id)
      )
        continue;
      const events = await this.db.query(
        "SELECT chunk FROM run_events WHERE run_id=$1 AND COALESCE((chunk->>'transient')::boolean,false)=false ORDER BY seq",
        [run.id],
      );
      session.messages.splice(
        userIndex + 1,
        0,
        await interruptedMessage(
          run.id,
          run.status,
          run.errorCode,
          events.map((e) => e.chunk),
        ),
      );
    }
    if (
      session.messages.some(
        (m) => m.role === "assistant" && m.metadata?.runId === session.resumeRun?.id,
      )
    )
      session.resumeRun = null;
    return session;
  }
  async workspace(actor: Principal, projectId: string, id: string) {
    await this.run(actor, projectId, id);
    // Exclude request payloads and token deltas from the workspace projection.
    const rows = await this.db.query(
      `SELECT seq,chunk,created_at FROM run_events WHERE run_id=$1 AND
       (chunk->>'type' IN ('tool-input-start','tool-input-available','tool-output-available','tool-output-error','data-subagent','data-skill-activation') OR
        (chunk->>'type'='data-subagent-event' AND chunk->'data'->'chunk'->>'type' IN ('tool-input-start','tool-input-available','tool-output-available','tool-output-error','text-delta','reasoning-delta','data-skill-activation')))
       ORDER BY seq`,
      [id],
    );
    const projected = projectRunWorkspace(
      rows.map((row) => ({
        seq: Number(row.seq),
        chunk: row.chunk as Record<string, unknown>,
        createdAt: new Date(String(row.created_at)).toISOString(),
      })),
    );
    const artifacts = await this.db.query(
      "SELECT * FROM task_artifacts WHERE run_id=$1 ORDER BY created_at",
      [id],
    );
    for (const row of artifacts) {
      const bytes = row.bytes as Buffer;
      const metadata = {
        id: `file-${row.id}`,
        name: String(row.name),
        mediaType: String(row.media_type),
        size: bytes.length,
        sha256: String(row.sha256),
        toolCallId: String(row.tool_call_id),
        subagentId: null,
        createdAt: new Date(String(row.created_at)).toISOString(),
        source: "workspace" as const,
      };
      projected.files.push({ metadata, bytes });
      if (
        !projected.workspace.artifacts.some(
          (file) =>
            file.name === metadata.name &&
            file.mediaType === metadata.mediaType &&
            file.sha256 === metadata.sha256,
        )
      )
        projected.workspace.artifacts.push(metadata);
    }
    const [execution] = await this.db.query(
      "SELECT r.conversation_id,r.deadline,r.recovery_count,l.snapshot,(SELECT count(*) FROM run_model_reservations b WHERE b.run_id=r.id) AS calls,(SELECT coalesce(sum(coalesce(actual_tokens,estimated_tokens)),0) FROM run_model_reservations b WHERE b.run_id=r.id) AS reserved FROM runs r JOIN releases l ON l.id=r.release_id WHERE r.id=$1",
      [id],
    );
    const agent = ReleaseSnapshot.parse(execution.snapshot).agent,
      limits = ExecutionLimits.parse(agent.executionLimits ?? {});
    projected.workspace.execution = {
      maxSteps: agent.maxSteps,
      maxModelCalls: limits.maxModelCalls,
      modelCalls: Number(execution.calls),
      reservedTokens: Number(execution.reserved),
      maxTokens: limits.maxTokens,
      recoveries: Number(execution.recovery_count),
      deadline: new Date(String(execution.deadline)).toISOString(),
    };
    projected.workspace.feedback = (
      await this.db.query("SELECT * FROM task_feedback WHERE run_id=$1 ORDER BY position", [id])
    ).map(feedbackDto);
    const [state] = await this.db.query(
      "SELECT data FROM conversation_task_state WHERE conversation_id=$1 AND run_id=$2",
      [execution.conversation_id, id],
    );
    if (state)
      projected.workspace.taskState = TaskStateInput.extend({
        revision: z.number(),
        runId: Id,
      }).parse(state.data);
    return projected;
  }
  async createRun(
    actor: Principal,
    projectId: string,
    conversationId: string,
    input: string,
    requestId: string,
    skillVersionIds: string[] = [],
    assistantOnly = false,
  ) {
    if (assistantOnly) {
      await this.projects.access.require(actor, projectId, "project.read");
      const [session] = await this.db.query(
        "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 AND project_id=$2 AND actor_id=$3",
        [conversationId, projectId, actor.id],
      );
      if (!session || actor.kind !== "user") throw notFound();
    } else await this.projects.access.require(actor, projectId, "agent.run");
    const runId = await this.db.transaction((tx) =>
      this.enqueue(tx, actor, projectId, conversationId, input, requestId, skillVersionIds),
    );
    return this.run(actor, projectId, runId);
  }
  private async enqueue(
    tx: Queryable,
    actor: Principal,
    projectId: string,
    conversationId: string,
    input: string,
    requestId: string,
    skillVersionIds: string[],
  ) {
    const selection = [...new Set(SkillSelection.parse(skillVersionIds))].sort();
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
    // Manual /compact, or automatic compaction once the last measured model
    // context reaches ~75% of the agent's window (Observational-Memory-style
    // threshold): the run first summarizes history, then answers normally.
    // Auto-compaction is best effort — an over-budget transcript just skips it.
    const compact = /^\/compact(?:\s|$)/i.test(input.trim());
    let autoCompact = false;
    if (!compact) {
      const window = snapshot.agent.executionLimits?.contextTokens ?? 32000;
      const [usage] = await tx.query(
        `SELECT e.chunk->'data'->'usage'->>'inputTokens' AS tokens
         FROM run_events e JOIN runs r ON r.id=e.run_id
         WHERE r.conversation_id=$1 AND e.chunk->>'type'='data-model-step'
         ORDER BY r.created_at DESC,r.id DESC,e.seq DESC LIMIT 1`,
        [conversationId],
      );
      autoCompact = Number(usage?.tokens ?? 0) >= Math.floor(window * 0.75);
    }
    if (compact) {
      if (input.replace(/^\/compact\s*/i, "").length > 1000)
        throw new ApiError(400, "INVALID_COMMAND", "压缩关注点请控制在 1000 字以内");
      const transcript = compactTranscript(await modelHistory(tx, conversationId));
      if (!transcript.trim()) throw new ApiError(409, "EMPTY_CONTEXT", "当前没有需要压缩的历史");
      if (transcript.length > 1000000)
        throw new ApiError(
          409,
          "CONTEXT_TOO_LARGE",
          "本次历史超过压缩预算，请新建会话或分阶段整理",
        );
    }
    if (autoCompact && !compact) {
      const transcript = compactTranscript(await modelHistory(tx, conversationId));
      if (!transcript.trim() || transcript.length > 1000000) autoCompact = false;
    }
    const id = randomUUID(),
      messageId = randomUUID();
    await tx.query(
      "INSERT INTO runs(id,tenant_id,project_id,actor_id,entry,conversation_id,release_id,request_id,input_hash,runtime_id,status,deadline,input_text,skill_version_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',now()+make_interval(secs=>$13),$11,$12)",
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
        snapshot.agent.executionLimits?.timeoutSeconds ??
          Math.max(180, snapshot.agent.maxSteps * 30),
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
    if (compact || autoCompact)
      await tx.query(
        "UPDATE runs SET context_action='compact',context_through=(SELECT max(position) FROM messages WHERE conversation_id=$2) WHERE id=$1",
        [id, conversationId],
      );
    // A conversation reused from the blank placeholder takes its name from the first message.
    const title = conversationTitle(input);
    if (title)
      await tx.query(
        "UPDATE conversations SET title=$1 WHERE id=$2 AND (title='' OR title='新会话')",
        [title, conversationId],
      );
    return id;
  }
  async edit(
    actor: Principal,
    projectId: string,
    conversationId: string,
    input: { messageId: string; input: string; requestId: string },
  ) {
    const result = await this.db.transaction(async (tx) => {
      const source = await this.get(actor, projectId, conversationId, tx, true);
      const hash = sha256(JSON.stringify({ messageId: input.messageId, input: input.input }));
      const [prior] = await tx.query(
        "SELECT id,branch_input_hash FROM conversations WHERE parent_conversation_id=$1 AND branch_request_id=$2",
        [conversationId, input.requestId],
      );
      if (prior) {
        if (prior.branch_input_hash !== hash)
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的编辑");
        return text(prior, "id");
      }
      const [active] = await tx.query(
        "SELECT id FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
        [conversationId],
      );
      if (active) throw new ApiError(409, "CONVERSATION_BUSY", "请等待当前回复完成或停止后再编辑");
      // Live user ids are request ids; restored messages use server ids. Both are
      // resolved inside the authorized conversation, never trusted as history.
      const [message] = await tx.query(
        `SELECT m.* FROM messages m LEFT JOIN runs r ON r.id::text=m.data->'metadata'->>'runId' AND r.conversation_id=m.conversation_id
         WHERE m.conversation_id=$1 AND m.data->>'role'='user' AND (m.id=$2 OR r.request_id=$2) ORDER BY m.position LIMIT 1`,
        [conversationId, input.messageId],
      );
      if (!message) throw notFound();
      const history = await tx.query(
        "SELECT data FROM messages WHERE conversation_id=$1 AND position<$2 ORDER BY position",
        [conversationId, message.position],
      );
      // Interrupted replies live in the event log. Preserve their observed content
      // in the branch too, with links back to the original run's full trajectory.
      const savedReplies = new Set(
        history
          .map((row) => Message.parse(row.data))
          .filter((item) => item.role === "assistant")
          .map((item) => item.metadata?.runId),
      );
      const branchHistory: z.infer<typeof Message>[] = [];
      for (const row of history) {
        branchHistory.push(Message.parse(row.data));
        const item = branchHistory.at(-1);
        if (item?.role !== "user" || !item.metadata?.runId || savedReplies.has(item.metadata.runId))
          continue;
        const [run] = await tx.query(
          "SELECT status,error_code FROM runs WHERE id=$1 AND conversation_id=$2 AND status IN ('failed','cancelled')",
          [item.metadata.runId, conversationId],
        );
        if (!run) continue;
        const events = await tx.query(
          "SELECT chunk FROM run_events WHERE run_id=$1 AND COALESCE((chunk->>'transient')::boolean,false)=false ORDER BY seq",
          [item.metadata.runId],
        );
        branchHistory.push(
          await interruptedMessage(
            item.metadata.runId,
            run.status === "cancelled" ? "cancelled" : "failed",
            run.error_code ? String(run.error_code) : null,
            events.map((event) => event.chunk),
          ),
        );
      }
      const id = randomUUID();
      await tx.query(
        `INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title,parent_conversation_id,parent_message_id,branch_request_id,branch_input_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          actor.tenantId,
          projectId,
          actor.id,
          actor.entry,
          source.agentId,
          source.releaseId,
          conversationTitle(input.input),
          conversationId,
          message.id,
          input.requestId,
          hash,
        ],
      );
      for (const data of branchHistory) {
        const copied = {
          ...data,
          id: randomUUID(),
          ...(data.metadata
            ? {
                metadata: {
                  ...data.metadata,
                  originConversationId: data.metadata.originConversationId ?? conversationId,
                },
              }
            : {}),
        };
        await tx.query("INSERT INTO messages(id,conversation_id,data) VALUES($1,$2,$3)", [
          copied.id,
          id,
          copied,
        ]);
      }
      const data = message.data as { metadata?: { selectedSkills?: { versionId: string }[] } };
      await this.enqueue(
        tx,
        actor,
        projectId,
        id,
        input.input,
        input.requestId,
        (data.metadata?.selectedSkills ?? []).map((skill) => skill.versionId),
      );
      return id;
    });
    return this.get(actor, projectId, result);
  }
  /** Derive a branch that copies saved history up to and including one message.
   * Nothing is re-run; the user continues the derived conversation themselves. */
  async derive(
    actor: Principal,
    projectId: string,
    conversationId: string,
    input: { upToMessageId: string; requestId: string },
  ) {
    const result = await this.db.transaction(async (tx) => {
      const source = await this.get(actor, projectId, conversationId, tx, true);
      const [prior] = await tx.query(
        "SELECT id FROM conversations WHERE parent_conversation_id=$1 AND branch_request_id=$2",
        [conversationId, input.requestId],
      );
      if (prior) return text(prior, "id");
      const [message] = await tx.query(
        `SELECT m.position FROM messages m LEFT JOIN runs r ON r.id::text=m.data->'metadata'->>'runId' AND r.conversation_id=m.conversation_id
         WHERE m.conversation_id=$1 AND (m.id=$2 OR r.request_id=$2) ORDER BY m.position LIMIT 1`,
        [conversationId, input.upToMessageId],
      );
      if (!message) throw notFound();
      const history = await tx.query(
        "SELECT data FROM messages WHERE conversation_id=$1 AND position<=$2 ORDER BY position",
        [conversationId, message.position],
      );
      if (!history.length) throw notFound();
      const id = randomUUID();
      await tx.query(
        `INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title,parent_conversation_id,parent_message_id,branch_request_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          actor.tenantId,
          projectId,
          actor.id,
          actor.entry,
          source.agentId,
          source.releaseId,
          `${source.title}（派生）`,
          conversationId,
          message.id,
          input.requestId,
        ],
      );
      for (const row of history) {
        const data = Message.parse(row.data);
        const copied = {
          ...data,
          id: randomUUID(),
          ...(data.metadata
            ? {
                metadata: {
                  ...data.metadata,
                  originConversationId: data.metadata.originConversationId ?? conversationId,
                },
              }
            : {}),
        };
        await tx.query("INSERT INTO messages(id,conversation_id,data) VALUES($1,$2,$3)", [
          copied.id,
          id,
          copied,
        ]);
      }
      return id;
    });
    return this.get(actor, projectId, result);
  }
  async run(actor: Principal, projectId: string, id: string) {
    const access = await this.projects.access.project(actor, projectId);
    const [r] = await this.db.query(
      "SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name FROM runs q JOIN releases r ON q.release_id=r.id WHERE q.id=$1 AND q.project_id=$2 AND q.actor_id=$3 AND q.entry=$4",
      [id, projectId, actor.id, actor.entry],
    );
    if (!r) throw notFound();
    if (Number(r.version) === 0 && !access.permissions.includes("agent.edit"))
      throw new ApiError(403, "FORBIDDEN", "当前角色不能访问草稿试用");
    return runDto((await restoreLegacyInputs(this.db, [r]))[0]);
  }
  async runs(actor: Principal, projectId: string, input: PageInput = {}, conversationId?: string) {
    const access = await this.projects.access.project(actor, projectId);
    if (conversationId) await this.get(actor, projectId, conversationId);
    const page = cursorPage(
      ["runs", actor.tenantId, projectId, actor.id, actor.entry, conversationId ?? ""],
      input,
    );
    const rows = await this.db.query(
      `SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name,${page.select("q")}
       FROM runs q JOIN releases r ON q.release_id=r.id
       WHERE q.project_id=$1 AND q.actor_id=$2 AND q.entry=$3 AND (r.kind='published' OR $8::boolean) AND ${page.where("q", 4)} AND ($7::uuid IS NULL OR q.conversation_id=$7)
       ORDER BY q.created_at DESC,q.id DESC LIMIT $6`,
      [
        projectId,
        actor.id,
        actor.entry,
        ...page.values,
        conversationId ?? null,
        access.permissions.includes("agent.edit"),
      ],
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
    const access = await this.projects.access.project(actor, projectId);
    return listConversationSummaries(
      this.db,
      actor,
      projectId,
      input,
      access.permissions.includes("agent.edit"),
    );
  }
  async events(actor: Principal, projectId: string, id: string, after = -1, through?: number) {
    await this.run(actor, projectId, id);
    return (
      await this.db.query(
        "SELECT * FROM run_events WHERE run_id=$1 AND seq>$2 AND ($3::int IS NULL OR seq<=$3) ORDER BY seq LIMIT 500",
        [id, after, through ?? null],
      )
    ).map(runEventDto);
  }
  /** Rename or pin a conversation; unspecified fields keep their current value. */
  async update(
    actor: Principal,
    projectId: string,
    id: string,
    input: { title?: string; pinned?: boolean },
  ) {
    await this.get(actor, projectId, id);
    const sets: string[] = [],
      values: unknown[] = [id];
    if (input.title !== undefined) {
      values.push(input.title);
      sets.push(`title=$${values.length}`);
    }
    if (input.pinned !== undefined) {
      values.push(input.pinned ? new Date() : null);
      sets.push(`pinned_at=$${values.length}`);
    }
    if (sets.length)
      await this.db.query(`UPDATE conversations SET ${sets.join(",")} WHERE id=$1`, values);
    return this.get(actor, projectId, id);
  }
  async remove(actor: Principal, projectId: string, id: string) {
    await this.db.transaction(async (tx) => {
      await this.get(actor, projectId, id, tx, true);
      const [active] = await tx.query(
        "SELECT id FROM runs WHERE conversation_id=$1 AND status IN ('queued','running')",
        [id],
      );
      if (active)
        throw new ApiError(409, "CONVERSATION_BUSY", "此会话正在执行，请先取消或等待完成");
      // No ON DELETE CASCADE: remove children before the conversation.
      await tx.query(
        "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=$1)",
        [id],
      );
      await tx.query("DELETE FROM messages WHERE conversation_id=$1", [id]);
      await tx.query("DELETE FROM conversation_task_state WHERE conversation_id=$1", [id]);
      await tx.query("DELETE FROM runs WHERE conversation_id=$1", [id]);
      await tx.query("DELETE FROM conversations WHERE id=$1 AND project_id=$2", [id, projectId]);
    });
    return { id };
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

import { ExecutionLimits } from "@platform/contracts";
