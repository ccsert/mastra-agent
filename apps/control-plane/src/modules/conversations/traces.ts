import {
  ConversationRunSummary,
  ConversationTrace,
  Message,
  type Principal,
  TraceQuery,
} from "@platform/contracts";
import type { Database, Queryable } from "@platform/database";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { date } from "../../infrastructure/records.ts";
import { conversationDto, restoreLegacyInputs, runDto, runEventDto } from "./records.ts";

/** Callers authorize the conversation before entering this read model. Runs remain independent jobs. */
export async function readConversationTrace(
  db: Database,
  conversationId: string,
  input: { before?: number; limit?: number },
) {
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return readTraceSnapshot(tx, conversationId, input);
  });
}
async function readTraceSnapshot(
  db: Queryable,
  conversationId: string,
  input: { before?: number; limit?: number },
) {
  const query = TraceQuery.parse(input);
  const initialRows = await db.query(
    `SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name,
      (SELECT count(*) FROM runs WHERE conversation_id=$1)::int AS total_turns
      FROM runs q JOIN releases r ON r.id=q.release_id WHERE q.conversation_id=$1
      ORDER BY q.created_at,q.id LIMIT 1`,
    [conversationId],
  );
  const pageRows = await db.query(
    `WITH numbered AS (
      SELECT q.*,row_number() OVER (ORDER BY q.created_at,q.id)::int AS turn_number
      FROM runs q WHERE q.conversation_id=$1
    ) SELECT q.*,r.version,r.snapshot,r.snapshot->'agent'->>'name' AS agent_name
      FROM numbered q JOIN releases r ON r.id=q.release_id
      WHERE ($2::int IS NULL OR q.turn_number<$2) ORDER BY q.turn_number DESC LIMIT $3`,
    [conversationId, query.before ?? null, query.limit],
  );
  const initial = initialRows[0];
  if (!initial)
    return ConversationTrace.parse({ initial: null, turns: [], totalTurns: 0, nextBefore: null });
  const rows = await restoreLegacyInputs(db, pageRows.reverse());
  const counts = await db.query(
    `SELECT run_id,count(*)::int AS event_count,max(seq)::int AS last_seq
      FROM run_events WHERE run_id=ANY($1::uuid[]) GROUP BY run_id`,
    [rows.map((r) => r.id)],
  );
  const messages = await db.query(
    `SELECT data FROM messages WHERE conversation_id=$1
      AND data->'metadata'->>'runId'=ANY($2::text[]) ORDER BY created_at,id`,
    [conversationId, rows.map((r) => r.id)],
  );
  const capturedAt = new Date().toISOString();
  // Summary turns skip event payloads; clients read them per run on demand.
  const eventRows =
    query.events === "full"
      ? await db.query(
          `SELECT q.id AS run_id,e.* FROM unnest($1::uuid[]) AS q(id)
          CROSS JOIN LATERAL (SELECT seq,chunk,created_at,occurred_at FROM run_events WHERE run_id=q.id ORDER BY seq LIMIT 501) e
          ORDER BY q.id,e.seq`,
          [rows.map((r) => r.id)],
        )
      : [];
  const requests = await db.query(
    "SELECT seq,chunk,created_at,occurred_at FROM run_events WHERE run_id=$1 AND chunk->>'type'='data-model-request' ORDER BY seq LIMIT 1",
    [initial.id],
  );
  const initialInput = await restoreLegacyInputs(db, [initial]);
  return ConversationTrace.parse({
    initial: {
      run: runDto(initialInput[0]),
      request: requests[0] ? runEventDto(requests[0]) : null,
    },
    turns: rows.map((r) => {
      const found = eventRows.filter((e) => e.run_id === r.id);
      const count = counts.find((c) => c.run_id === r.id);
      return {
        number: r.turn_number,
        run: runDto(r),
        events: found.slice(0, 500).map(runEventDto),
        hasMoreEvents:
          query.events === "summary" ? Number(count?.event_count ?? 0) > 0 : found.length > 500,
        checkpoint: {
          eventCount: count?.event_count ?? 0,
          lastSeq: count?.last_seq ?? -1,
          capturedAt,
        },
        messages: messages.flatMap((m) => {
          const parsed = Message.safeParse(m.data);
          return parsed.success && parsed.data.metadata?.runId === r.id ? [parsed.data] : [];
        }),
      };
    }),
    totalTurns: initial.total_turns,
    nextBefore: Number(rows[0]?.turn_number) > 1 ? Number(rows[0].turn_number) : null,
  });
}

export async function listConversationSummaries(
  db: Database,
  actor: Principal,
  projectId: string,
  input: PageInput,
  includePreviews = false,
) {
  const page = cursorPage(
    ["conversation-runs", actor.tenantId, projectId, actor.id, actor.entry],
    input,
  );
  const rows = await db.query(
    `SELECT c.*,r.version,r.snapshot->'agent'->>'name' AS agent_name,
      latest.id AS latest_run_id,latest.status AS latest_status,latest.created_at AS last_run_at,
      (SELECT count(*) FROM runs WHERE conversation_id=c.id)::int AS run_count,${page.select("c")}
    FROM conversations c JOIN releases r ON r.id=c.release_id
    JOIN LATERAL (SELECT id,status,created_at FROM runs WHERE conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true
    WHERE c.project_id=$1 AND c.tenant_id=$2 AND c.actor_id=$3 AND c.entry=$4 AND (r.kind='published' OR $8::boolean) AND ${page.where("c", 5)}
    ORDER BY c.created_at DESC,c.id DESC LIMIT $7`,
    [projectId, actor.tenantId, actor.id, actor.entry, ...page.values, includePreviews],
  );
  return page.result(rows, (r) =>
    ConversationRunSummary.parse({
      ...conversationDto(r),
      agentName: r.agent_name,
      runCount: r.run_count,
      latestRunId: r.latest_run_id,
      latestStatus: r.latest_status,
      lastRunAt: date(r.last_run_at),
    }),
  );
}
