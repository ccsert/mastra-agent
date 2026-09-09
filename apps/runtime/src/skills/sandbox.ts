import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SkillPath } from "@platform/contracts";

const exec = promisify(execFile);
const docker = async (args: string[]) =>
  (await exec("docker", args, { timeout: 15000, maxBuffer: 1048576 })).stdout.trim();
const interpreter = (path: string) =>
  path.endsWith(".py")
    ? "/usr/bin/python3"
    : path.endsWith(".sh")
      ? "/bin/bash"
      : /\.(m?js|cjs)$/.test(path)
        ? "/usr/local/bin/node"
        : undefined;
export type SkillSandboxInput = {
  image: string | undefined;
  path: string;
  files: Map<string, Buffer>;
  input: Record<string, unknown>;
  signal: AbortSignal;
};
/** Docker is the trusted execution manager. The script never receives its socket, host files or environment. */
export async function runSkillSandbox({ image, path, files, input, signal }: SkillSandboxInput) {
  if (!image || !/^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image))
    throw new Error("SKILL_SANDBOX_UNAVAILABLE");
  const command = interpreter(path);
  if (!command || !files.has(path) || !path.startsWith("scripts/"))
    throw new Error("SKILL_ACCESS_DENIED");
  const stdin = JSON.stringify(input);
  if (Buffer.byteLength(stdin) > 65536) throw new Error("SKILL_INPUT_LIMIT");
  signal.throwIfAborted();
  const name = `platform-skill-${randomUUID()}`,
    root = await mkdtemp(join(tmpdir(), "platform-skill-"));
  let createAttempted = false;
  try {
    const folded = new Set<string>();
    for (const [file, bytes] of files) {
      if (!SkillPath.safeParse(file).success || folded.has(file.normalize("NFC").toLowerCase()))
        throw new Error("SKILL_CONTENT_INVALID");
      folded.add(file.normalize("NFC").toLowerCase());
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { mode: 0o444, flag: "wx" });
    }
    await chmod(root, 0o755);
    signal.throwIfAborted();
    createAttempted = true;
    // Stage into a private volume with a stopped helper, then attach it read-only to the script.
    // Docker cp cannot write a read-only rootfs; no host bind path is required by this transfer.
    await docker([
      "volume",
      "create",
      "--label",
      "agent-platform.component=skill-execution",
      `${name}-package`,
    ]);
    await docker([
      "create",
      "--name",
      `${name}-prepare`,
      "--pull=never",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=volume,source=${name}-package,target=/skill`,
      "--entrypoint",
      "/bin/true",
      image,
    ]);
    await docker(["cp", `${root}/.`, `${name}-prepare:/skill`]);
    await docker(["rm", `${name}-prepare`]);
    signal.throwIfAborted();
    await docker([
      "create",
      "--name",
      name,
      "--label",
      "agent-platform.component=skill-execution",
      "--pull=never",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--memory",
      "128m",
      "--memory-swap",
      "128m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "64",
      "--ulimit",
      "nofile=128:128",
      "--log-driver",
      "none",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
      "--tmpfs",
      "/work:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000,mode=700",
      "--mount",
      `type=volume,source=${name}-package,target=/skill,readonly`,
      "--workdir",
      "/work",
      "--env",
      "HOME=/tmp",
      "--env",
      "PYTHONDONTWRITEBYTECODE=1",
      "--entrypoint",
      command,
      "-i",
      image,
      `/skill/${path}`,
    ]);
    signal.throwIfAborted();
    return await new Promise<{ stdout: string; stderr: string; exitCode: number; image: string }>(
      (resolve, reject) => {
        const child = spawn("docker", ["start", "--attach", "--interactive", name], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let size = 0,
          failure: Error | undefined,
          stopping: Promise<unknown> | undefined;
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        const stop = (error: Error) => {
          if (failure) return;
          failure = error;
          stopping = docker(["rm", "--force", name]).catch(() => {});
        };
        const abort = () =>
          stop(signal.reason instanceof Error ? signal.reason : new Error("CANCELLED"));
        const timer = setTimeout(() => stop(new Error("SKILL_TIMEOUT")), 30000);
        // Bound even a hung Docker client. Removing the container remains mandatory in finally.
        const hardTimer = setTimeout(() => {
          stop(new Error("SKILL_TIMEOUT"));
          child.kill("SIGKILL");
        }, 47000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const receive = (chunk: Buffer, channel: "stdout" | "stderr") => {
          const kept = chunk.subarray(0, Math.max(0, 65536 - size));
          size += chunk.length;
          if (kept.length) (channel === "stdout" ? stdout : stderr).push(Buffer.from(kept));
          if (size > 65536) stop(new Error("SKILL_OUTPUT_LIMIT"));
        };
        child.stdout.on("data", (chunk: Buffer) => receive(chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => receive(chunk, "stderr"));
        child.stdin.on("error", () => {});
        child.stdin.end(`${stdin}\n`);
        child.once("error", () => stop(new Error("SKILL_SANDBOX_UNAVAILABLE")));
        child.once("close", async (code) => {
          clearTimeout(timer);
          clearTimeout(hardTimer);
          signal.removeEventListener("abort", abort);
          await stopping;
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error("SKILL_SCRIPT_FAILED"));
          else
            resolve({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              exitCode: 0,
              image,
            });
        });
      },
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.message.startsWith("SKILL_")) throw error;
    throw new Error("SKILL_SANDBOX_UNAVAILABLE", { cause: error });
  } finally {
    await cleanup(name, root, createAttempted);
  }
}

async function cleanup(name: string, root: string, attempted: boolean) {
  try {
    if (attempted) {
      for (const container of [name, `${name}-prepare`]) {
        if (await docker(["ps", "-aq", "--filter", `name=^/${container}$`]))
          await docker(["rm", "--force", container]);
        if (await docker(["ps", "-aq", "--filter", `name=^/${container}$`]))
          throw new Error("SKILL_CLEANUP_FAILED");
      }
      if (await docker(["volume", "ls", "-q", "--filter", `name=^${name}-package$`]))
        await docker(["volume", "rm", `${name}-package`]);
    }
  } catch {
    throw new Error("SKILL_CLEANUP_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
