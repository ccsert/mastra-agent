import { createHash } from "node:crypto";
import { BlobStore, type StorageBlobEntry } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { CompositeVersionedSkillSource, Workspace } from "@mastra/core/workspace";
import {
  type SkillAccessRequest,
  SkillFileContent,
  type SkillSnapshot,
  z,
} from "@platform/contracts";
import { runSkillSandbox } from "./sandbox.ts";

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
) {
  if (!snapshots.length) return { signal: parent, workspace: undefined, tools: {}, close() {} };
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
  let executing = false;
  const tool = createTool({
    id: "run_skill_script",
    description:
      "Run a pre-authorized Skill script. Input is supplied as JSON on stdin; stdout is the result. Call one script at a time. No network, business credentials or host files. Allowed entries: " +
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
      if (executing) {
        const error = new Error("SKILL_CALL_LIMIT");
        stop.abort(error);
        throw error;
      }
      executing = true;
      try {
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
      } finally {
        executing = false;
      }
    },
  });
  return {
    signal,
    workspace,
    tools: snapshots.some((s) => s.authorizedEntrypoints.length) ? { run_skill_script: tool } : {},
    close() {
      clearInterval(timer);
      stop.abort();
    },
  };
}
