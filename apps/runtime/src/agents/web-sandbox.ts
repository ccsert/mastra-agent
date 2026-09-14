import { execFile, spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { promisify } from "node:util";
import {
  type CommandResult,
  type ExecuteCommandOptions,
  MastraSandbox,
} from "@mastra/core/workspace";

const exec = promisify(execFile);
export const dockerCommand = async (args: string[]) =>
  (await exec("docker", args, { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Commands run inside a networkless container. Only the task directory is mounted. */
export class WebTaskSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = "web-task";
  readonly provider = "platform-docker";
  status: "pending" | "running" | "stopped" | "error" = "pending";
  constructor(
    readonly container: string,
    readonly root: string,
    readonly image: string,
    readonly signal: AbortSignal,
  ) {
    super({ name: "web-task", workingDirectory: "/workspace" });
    this.id = container;
  }
  async start() {
    if (!/^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(this.image))
      throw new Error("WORKSPACE_UNAVAILABLE");
    const existing = await dockerCommand(["ps", "-aq", "--filter", `name=^/${this.container}$`]);
    if (existing) await dockerCommand(["rm", "--force", this.container]);
    await dockerCommand([
      "run",
      "--detach",
      "--name",
      this.container,
      "--label",
      "agent-platform.component=web-task",
      "--pull=never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--memory",
      "1536m",
      "--memory-swap",
      "1536m",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--shm-size",
      "256m",
      "--log-driver",
      "none",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      "--mount",
      `type=bind,source=${this.root},target=/workspace`,
      this.image,
    ]);
    this.status = "running";
  }
  async prepareDependencies() {
    await dockerCommand([
      "exec",
      "--workdir",
      "/workspace",
      this.container,
      "sh",
      "-c",
      'if [ -L node_modules ] && [ "$(readlink node_modules)" = /opt/web/node_modules ]; then rm node_modules; fi; mkdir -p node_modules; for package in /opt/web/node_modules/*; do target="node_modules/$(basename "$package")"; if [ ! -e "$target" ] && [ ! -L "$target" ]; then ln -s "$package" "$target"; fi; done',
    ]);
  }
  async stop() {
    await dockerCommand(["rm", "--force", this.container]);
    this.status = "stopped";
  }
  async destroy() {
    await this.stop();
  }
  async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    this.signal.throwIfAborted();
    const started = Date.now(),
      timeout = Math.min(120000, Math.max(100, options.timeout ?? 60000));
    const cwd = options.cwd ?? "/workspace";
    if (cwd !== "/workspace" && !cwd.startsWith("/workspace/"))
      throw new Error("WORKSPACE_UNAVAILABLE");
    const script = args.length ? [quote(command), ...args.map(quote)].join(" ") : command;
    try {
      const { stdout, stderr } = await exec(
        "docker",
        [
          "exec",
          "--workdir",
          cwd,
          this.container,
          "timeout",
          "--signal=TERM",
          "--kill-after=2",
          `${Math.ceil(timeout / 1000)}s`,
          "/bin/sh",
          "-c",
          script,
        ],
        {
          signal: AbortSignal.any([
            this.signal,
            ...(options.abortSignal ? [options.abortSignal] : []),
          ]),
          timeout: timeout + 6000,
          maxBuffer: 262144,
        },
      );
      return { success: true, exitCode: 0, stdout, stderr, executionTimeMs: Date.now() - started };
    } catch (error) {
      this.signal.throwIfAborted();
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      if (typeof failure.code !== "number") throw new Error("WORKSPACE_COMMAND_FAILED");
      return {
        success: false,
        exitCode: failure.code,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        timedOut: failure.code === 124,
        executionTimeMs: Date.now() - started,
      };
    }
  }
}

/** CDP is forwarded through Docker exec/stdin, so the browser needs no network
 * interface or published port. This listener never accepts non-loopback clients. */
export async function browserTunnel(container: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 8) return socket.destroy();
    sockets.add(socket);
    const child = spawn(
      "docker",
      ["exec", "-i", container, "socat", "STDIO", "TCP:127.0.0.1:9222"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stdin.on("error", () => socket.destroy());
    child.on("error", () => socket.destroy());
    child.on("close", () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      child.kill();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WORKSPACE_UNAVAILABLE");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
