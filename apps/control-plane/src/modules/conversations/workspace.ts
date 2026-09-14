import { createHash } from "node:crypto";
import {
  RunWorkspace,
  SkillActivation,
  SubagentEvent,
  SubagentLifecycle,
  type z,
} from "@platform/contracts";

type Event = { seq: number; chunk: Record<string, unknown>; createdAt: string };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : "");
type Workspace = z.infer<typeof RunWorkspace>;
type File = { metadata: Workspace["artifacts"][number]; bytes: Uint8Array };
const excluded = new Set([
  "skill",
  "skill_read",
  "skill_search",
  "update_plan",
  "delegate_task",
  "knowledge_search",
]);

/** Projects recorded facts, never paths or file claims found in assistant prose. */
export function projectRunWorkspace(events: Event[]) {
  const files: File[] = [],
    calls = new Map<string, { name: string; done: boolean }>();
  const children = new Map<string, Workspace["subagents"][number]>();
  const skills = new Map<string, Workspace["skills"][number]>();
  for (const event of events) {
    let chunk = event.chunk,
      childId: string | null = null;
    if (chunk.type === "data-subagent") {
      const checked = SubagentLifecycle.safeParse(chunk.data);
      if (checked.success) {
        const previous = children.get(checked.data.id);
        children.set(checked.data.id, {
          toolCount: 0,
          completedTools: 0,
          activity: "",
          outputText: "",
          ...previous,
          ...checked.data,
        });
      }
      continue;
    }
    if (chunk.type === "data-subagent-event") {
      const checked = SubagentEvent.safeParse(chunk.data);
      if (!checked.success) continue;
      childId = checked.data.id;
      chunk = checked.data.chunk;
    }
    if (chunk.type === "data-skill-activation") {
      const checked = SkillActivation.safeParse(chunk.data);
      if (checked.success)
        skills.set(`${childId ?? "root"}:${checked.data.versionId}`, {
          ...checked.data,
          subagentId: childId,
        });
    }
    const child = childId ? children.get(childId) : undefined;
    if (child && chunk.type === "text-delta")
      child.outputText = (child.outputText + string(chunk.delta)).slice(-12000);
    if (child && chunk.type === "reasoning-delta")
      child.activity = (child.activity + string(chunk.delta)).slice(-180);
    const callId = string(chunk.toolCallId),
      key = `${childId ?? "root"}:${callId}`;
    if ((chunk.type === "tool-input-start" || chunk.type === "tool-input-available") && callId) {
      if (!calls.has(key) && child) child.toolCount++;
      calls.set(key, { name: string(chunk.toolName), done: false });
      if (child) child.activity = `正在调用 ${string(chunk.toolName)}`;
    }
    if ((chunk.type === "tool-output-available" || chunk.type === "tool-output-error") && callId) {
      const call = calls.get(key);
      if (!call) continue;
      if (child && !call.done) child.completedTools++;
      call.done = true;
      if (child)
        child.activity =
          chunk.type === "tool-output-error" ? `${call.name} 执行失败` : `${call.name} 已完成`;
      if (
        chunk.type !== "tool-output-available" ||
        excluded.has(call.name) ||
        /^(browser_|workspace_|task_|mastra_workspace_|platform_)/.test(call.name)
      )
        continue;
      const output = chunk.output;
      if (output === undefined || record(output).isError === true) continue;
      const script = call.name === "run_skill_script",
        result = record(output);
      if (script && result.exitCode !== 0) continue;
      const raw = script ? string(result.stdout) : JSON.stringify(output, null, 2);
      if (!raw?.trim()) continue;
      let parsed: unknown = output,
        extension = "json";
      if (script) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          extension = "txt";
        }
      }
      const source = script ? ("script-stdout" as const) : ("tool-result" as const);
      const name =
        (script ? string(result.skill) : call.name)
          .replace(/[^\p{L}\p{N}._-]/gu, "_")
          .slice(0, 60) || "result";
      const add = (ext: string, content: string, mediaType: string) => {
        const bytes = new TextEncoder().encode(content);
        if (bytes.length > 1024 * 1024) return;
        files.push({
          bytes,
          metadata: {
            id: `${event.seq}-${ext}`,
            name: `${name}-${event.seq}.${ext}`,
            mediaType,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            toolCallId: callId,
            subagentId: childId,
            createdAt: event.createdAt,
            source,
          },
        });
      };
      add(
        extension,
        extension === "json" ? JSON.stringify(parsed, null, 2) : raw,
        extension === "json" ? "application/json" : "text/plain",
      );
      const rows = Array.isArray(parsed)
        ? parsed
        : Object.values(record(parsed)).find(Array.isArray);
      if (
        Array.isArray(rows) &&
        rows.length &&
        rows.length <= 10000 &&
        rows.every(
          (r) =>
            Object.keys(record(r)).length > 0 &&
            Object.values(record(r)).every(
              (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
            ),
        )
      ) {
        const headers = [...new Set(rows.flatMap((row) => Object.keys(record(row))))];
        const cell = (value: unknown) => {
          const text = value == null ? "" : String(value);
          // Quoting alone does not prevent spreadsheet formula execution.
          return `"${(/^[\s]*[=+@-]/.test(text) && typeof value === "string" ? `'${text}` : text).replaceAll('"', '""')}"`;
        };
        add(
          "csv",
          [
            headers.map(cell).join(","),
            ...rows.map((row) => headers.map((h) => cell(record(row)[h])).join(",")),
          ].join("\r\n"),
          "text/csv",
        );
      }
    }
  }
  return {
    workspace: RunWorkspace.parse({
      skills: [...skills.values()],
      subagents: [...children.values()],
      artifacts: files.map((f) => f.metadata),
    }),
    files,
  };
}
