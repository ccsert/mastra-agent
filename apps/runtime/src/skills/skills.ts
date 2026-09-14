import { createHash } from "node:crypto";
import { BlobStore, type StorageBlobEntry } from "@mastra/core/storage";
import { createTool, type ToolHooks } from "@mastra/core/tools";
import {
  CompositeVersionedSkillSource,
  formatSkillActivation,
  Workspace,
} from "@mastra/core/workspace";
import {
  type SkillAccessRequest,
  type SkillActivation,
  SkillFileContent,
  type SkillSnapshot,
  z,
} from "@platform/contracts";
import { runSkillSandbox } from "./sandbox.ts";
import { createScriptQueue } from "./script-queue.ts";

export type SkillAccess = (
  input: Omit<SkillAccessRequest, "leaseToken">,
  signal: AbortSignal,
) => Promise<unknown>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Mastra's source API expects a BlobStore; this adapter only exposes the immutable run-bound read side. */
class RunBlobs extends BlobStore {
  constructor(private readonly read: (hash: string) => Promise<StorageBlobEntry | null>) {
    super();
  }
  async init() {}
  get(hash: string) {
    return this.read(hash);
  }
  async has(hash: string) {
    return !!(await this.get(hash));
  }
  async getMany(hashes: string[]) {
    const out = new Map<string, StorageBlobEntry>();
    for (const hash of hashes) {
      const blob = await this.get(hash);
      if (blob) out.set(hash, blob);
    }
    return out;
  }
  async put(): Promise<void> {
    throw new Error("SKILL_ACCESS_DENIED");
  }
  async putMany(): Promise<void> {
    throw new Error("SKILL_ACCESS_DENIED");
  }
  async delete(): Promise<boolean> {
    throw new Error("SKILL_ACCESS_DENIED");
  }
  async dangerouslyClearAll(): Promise<void> {
    throw new Error("SKILL_ACCESS_DENIED");
  }
}
export async function prepareSkills(
  snapshots: SkillSnapshot[],
  access: SkillAccess | undefined,
  parent: AbortSignal,
  image?: string,
  selectedIds: string[] = [],
  onActivation?: (activation: z.infer<typeof SkillActivation>) => Promise<void>,
) {
  if (selectedIds.some((id) => !snapshots.some((s) => s.id === id)))
    throw new Error("SKILL_ACCESS_DENIED");
  if (!snapshots.length)
    return {
      signal: parent,
      workspace: undefined,
      tools: {},
      instructions: "",
      hooks: {} as ToolHooks,
      close() {},
    };
  if (!access) throw new Error("SKILL_ACCESS_DENIED");
  const stop = new AbortController(),
    signal = AbortSignal.any([parent, stop.signal]);
  const request: SkillAccess = async (input, signal) => {
    try {
      const value = await access(input, signal);
      signal.throwIfAborted();
      return value;
    } catch {
      const error = new Error("SKILL_ACCESS_DENIED");
      stop.abort(error);
      throw error;
    }
  };
  const check = () =>
    Promise.all(snapshots.map((s) => request({ versionId: s.id, operation: "check" }, signal)));
  await check();
  const read = async (version: SkillSnapshot, path: string) => {
    const file = version.files.find((f) => f.path === path);
    if (!file) throw new Error("SKILL_ACCESS_DENIED");
    const content = SkillFileContent.parse(
      await request({ versionId: version.id, operation: "read", path }, signal),
    );
    const bytes = Buffer.from(content.contentBase64, "base64");
    if (bytes.length !== file.size || hash(bytes) !== file.hash || content.hash !== file.hash) {
      const error = new Error("SKILL_CONTENT_INVALID");
      stop.abort(error);
      throw error;
    }
    return bytes;
  };
  const blobs = new RunBlobs(async (hash) => {
    for (const version of snapshots) {
      const file = version.files.find((f) => f.hash === hash);
      if (file) {
        const bytes = await read(version, file.path);
        return {
          hash,
          content: bytes.toString(file.encoding === "utf-8" ? "utf8" : "base64"),
          size: bytes.length,
          createdAt: new Date(version.createdAt),
        };
      }
    }
    return null;
  });
  const source = new CompositeVersionedSkillSource(
    snapshots.map((s) => ({
      dirName: s.name,
      versionCreatedAt: new Date(s.createdAt),
      tree: {
        entries: Object.fromEntries(
          s.files.map((f) => [f.path, { blobHash: f.hash, size: f.size, encoding: f.encoding }]),
        ),
      },
    })),
    blobs,
  );
  const workspace = new Workspace({
    skills: ["/"],
    skillSource: source,
    tools: { enabled: false },
  });
  const selected = snapshots.filter((s) => selectedIds.includes(s.id));
  const loaded = new Set(selected.map((s) => s.id));
  const instructions = selected.length
    ? "\n\n用户为本次任务明确指定以下 Skill。优先遵循这些 Skill 的工作方式，仍须遵守 Agent 的权限与任务边界；选择 Skill 不会扩大工具或脚本授权。\n" +
      (
        await Promise.all(
          selected.map(async (s) => {
            const skill = await workspace.skills?.get(s.name);
            if (!skill) throw new Error("SKILL_CONTENT_INVALID");
            // Use Mastra's activation payload, including package file listings,
            // for explicitly selected Skills as well as model-initiated calls.
            return `\n--- Skill ${s.name} v${s.version} ---\n${formatSkillActivation(skill)}\n--- End Skill ---`;
          }),
        )
      ).join("\n") +
      "\n以上 Skill 已在本轮加载，无需再次调用 skill 激活。可以直接使用 skill_read 读取其参考资料，或执行已授权脚本。\n"
    : "";
  const activated = async (
    version: SkillSnapshot,
    source: "selected" | "model",
    context?: unknown,
  ) => {
    const call =
      context && typeof context === "object" && "agent" in context ? context.agent : null;
    const toolCallId =
      call &&
      typeof call === "object" &&
      "toolCallId" in call &&
      typeof call.toolCallId === "string"
        ? call.toolCallId
        : null;
    await onActivation?.({
      versionId: version.id,
      name: version.name,
      version: version.version,
      source,
      loadedAt: new Date().toISOString(),
      toolCallId,
    });
  };
  for (const version of selected) await activated(version, "selected");
  const hooks: ToolHooks = {
    beforeToolCall: async ({ toolName, input }) => {
      if (toolName !== "skill") return;
      const checked = z.object({ name: z.string() }).safeParse(input);
      if (!checked.success) return;
      const skill = await workspace.skills?.get(checked.data.name);
      const version = snapshots.find((s) => s.name === skill?.name);
      if (!version || !loaded.has(version.id)) return;
      // Native hook short-circuit keeps the actual invocation visible, but does
      // not inject the same instructions again. Revocation is checked first.
      await check();
      return {
        proceed: false,
        output: `Skill ${version.name} v${version.version} 已在本轮加载。请使用已有指令与文件目录；无需重复激活。`,
      };
    },
    afterToolCall: async ({ toolName, input, output, error, context }) => {
      if (toolName !== "skill" || error !== undefined) return;
      const checked = z.object({ name: z.string() }).safeParse(input);
      if (!checked.success) return;
      const skill = await workspace.skills?.get(checked.data.name);
      const version = snapshots.find((s) => s.name === skill?.name);
      if (!skill || !version || loaded.has(version.id) || output !== formatSkillActivation(skill))
        return;
      loaded.add(version.id);
      await activated(version, "model", context);
    },
  };
  let checking = false;
  const timer = setInterval(() => {
    if (checking || signal.aborted) return;
    checking = true;
    void check()
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }, 2000);
  const enqueueScript = createScriptQueue(signal);
  const tool = createTool({
    id: "run_skill_script",
    description:
      "Run a pre-authorized Skill script. Input is supplied as JSON on stdin; stdout is the result. Calls are queued and executed one at a time. No network, business credentials or host files. Allowed entries: " +
      snapshots.flatMap((s) => s.authorizedEntrypoints.map((p) => `${s.name}: ${p}`)).join("; "),
    inputSchema: z
      .object({
        skillName: z.string(),
        entrypoint: z.string(),
        input: z.record(z.string(), z.unknown()),
      })
      .strict(),
    execute: async ({ skillName, entrypoint, input }) => {
      const version = snapshots.find((s) => s.name === skillName);
      if (!version?.authorizedEntrypoints.includes(entrypoint))
        throw new Error("SKILL_ACCESS_DENIED");
      return enqueueScript(async () => {
        await request({ versionId: version.id, operation: "execute", path: entrypoint }, signal);
        const files = new Map<string, Buffer>();
        for (const file of version.files) files.set(file.path, await read(version, file.path));
        // Recheck after content transfer and after execution. Revocation never turns into a successful output.
        await check();
        const output = await runSkillSandbox({
          image,
          path: entrypoint,
          files,
          input,
          signal,
        }).catch((error: unknown) => {
          stop.abort(error);
          throw error;
        });
        await check();
        return {
          skill: version.name,
          version: version.version,
          versionId: version.id,
          digest: version.digest,
          entrypoint,
          ...output,
        };
      });
    },
  });
  return {
    signal,
    workspace,
    instructions,
    hooks,
    tools: snapshots.some((s) => s.authorizedEntrypoints.length) ? { run_skill_script: tool } : {},
    close() {
      clearInterval(timer);
      stop.abort();
    },
  };
}
