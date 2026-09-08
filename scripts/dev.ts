import "./env.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { required } from "./env.ts";

required("DATABASE_URL");
const ports = [
  Number(process.env.API_PORT ?? 4110),
  Number(process.env.RUNTIME_PORT ?? 4112),
  Number(process.env.CONSOLE_PORT ?? 5179),
];
const consoleHost = process.env.CONSOLE_HOST ?? "0.0.0.0";
const consoleAddresses =
  consoleHost === "0.0.0.0"
    ? [
        "127.0.0.1",
        "localhost",
        ...Object.values(networkInterfaces())
          .flatMap((addresses) => addresses ?? [])
          .filter((address) => address.family === "IPv4" && !address.internal)
          .map((address) => address.address),
      ]
    : [consoleHost];
const consoleOrigins = consoleAddresses.map((address) => `http://${address}:${ports[2]}`);
// Trust only this machine's concrete console addresses, never arbitrary private-network origins.
process.env.CONSOLE_ADDITIONAL_ORIGINS = [
  ...new Set([
    ...(process.env.CONSOLE_ADDITIONAL_ORIGINS ?? "").split(",").filter(Boolean),
    ...consoleOrigins,
  ]),
].join(",");
const hosts = [
  process.env.API_HOST ?? "127.0.0.1",
  process.env.RUNTIME_HOST ?? "127.0.0.1",
  consoleHost,
];
for (const [index, port] of ports.entries()) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use`)));
    server.listen(port, hosts[index], () => server.close(() => resolve()));
  });
}
const children: ChildProcess[] = [];
let stopping = false;
function start(name: string, args: string[], keys?: string[]) {
  const env = keys
    ? Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", ...keys]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      )
    : process.env;
  const child = spawn("pnpm", args, { stdio: "inherit", env, detached: true });
  children.push(child);
  child.once("error", (error) => {
    console.error(`${name}: ${error.message}`);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`${name} exited (${code ?? "signal"})`);
      stop(code ?? 1);
    }
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Child already exited. */
      }
    }
  }
  setTimeout(() => process.exit(code), 1000);
}
start("Control plane", ["exec", "tsx", "apps/control-plane/src/main.ts"]);
start(
  "Runtime",
  ["exec", "tsx", "apps/runtime/src/main.ts"],
  ["CONTROL_PLANE_URL", "RUNTIME_TOKEN", "RUNTIME_ID", "RUNTIME_HOST", "RUNTIME_PORT"],
);
start(
  "Console",
  process.argv.includes("--preview")
    ? ["--filter", "@platform/console", "exec", "vite", "preview"]
    : ["--filter", "@platform/console", "dev"],
  ["CONTROL_PLANE_URL", "CONSOLE_HOST", "CONSOLE_PORT"],
);
for (const origin of new Set(consoleOrigins)) console.log(`Agent Platform console: ${origin}`);
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
