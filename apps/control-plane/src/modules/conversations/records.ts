import { Conversation, Message, ReleaseSnapshot, Run, SkillSelection } from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { date } from "../../infrastructure/records.ts";

export const selectedSkills = (snapshot: ReleaseSnapshot, ids: string[]) =>
  snapshot.skills
    .filter((s) => ids.includes(s.id))
    .map((s) => ({ versionId: s.id, name: s.name, version: s.version }));

export const conversationDto = (r: Row) =>
  Conversation.parse({
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    releaseId: r.release_id,
    releaseVersion: r.version,
    title: r.title,
    createdAt: date(r.created_at),
  });
export const runDto = (r: Row) =>
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
    inputText: r.input_text ?? null,
    agentInstructions: r.snapshot ? ReleaseSnapshot.parse(r.snapshot).agent.instructions : null,
    registeredTools: r.snapshot
      ? ReleaseSnapshot.parse(r.snapshot).tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }))
      : [],
    selectedSkills: r.snapshot
      ? selectedSkills(ReleaseSnapshot.parse(r.snapshot), SkillSelection.parse(r.skill_version_ids))
      : [],
  });
// Old runs retain a plain-text hash, but migration 8 did not backfill input_text.
// Recover only an exact match within the authorized run's own conversation.
export async function restoreLegacyInputs(db: Queryable, rows: Row[]): Promise<Row[]> {
  const legacy = rows.filter((r) => r.input_text == null);
  if (!legacy.length) return rows;
  const messages = await db.query(
    "SELECT conversation_id,data FROM messages WHERE conversation_id=ANY($1::uuid[]) AND data->>'role'='user'",
    [[...new Set(legacy.map((r) => r.conversation_id))]],
  );
  const inputs = new Map<string, string>();
  for (const row of messages) {
    const message = Message.safeParse(row.data);
    if (!message.success) continue;
    const input = message.data.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    inputs.set(`${row.conversation_id}:${sha256(input)}`, input);
  }
  return rows.map((r) => ({
    ...r,
    input_text: r.input_text ?? inputs.get(`${r.conversation_id}:${r.input_hash}`) ?? null,
  }));
}
