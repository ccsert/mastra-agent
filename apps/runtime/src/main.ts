import { once } from "node:events";
import { createServer } from "node:http";
import { createLogger, required } from "@platform/operations";
import { ControlConnection } from "./connection.ts";
import { runWorker } from "./worker.ts";

const log = createLogger("runtime");
async function start() {
  const controlPlaneUrl = required("CONTROL_PLANE_URL"),
    runtimeToken = required("RUNTIME_TOKEN"),
    runtimeId = process.env.RUNTIME_ID ?? "hosted-local";
  const controller = new AbortController(),
    connection = new ControlConnection();
  let stopping = false;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", runtimeId }));
    } else if (request.url === "/ready") {
      const health = connection.snapshot();
      response.statusCode = !stopping && health.status === "ready" ? 200 : 503;
      response.end(JSON.stringify({ ...health, runtimeId }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(
    Number(process.env.RUNTIME_PORT ?? 4112),
    process.env.RUNTIME_HOST ?? "127.0.0.1",
    () => log({ event: "started", runtimeId }),
  );
  await once(server, "listening");
  const worker = runWorker({
    controlPlaneUrl,
    runtimeToken,
    runtimeId,
    signal: controller.signal,
    skillSandboxImage: process.env.SKILL_SANDBOX_IMAGE,
    logger: log,
    onContact: (status) => connection.record(status),
  });
  async function stop() {
    if (stopping) return;
    stopping = true;
    log({ event: "stopping", runtimeId });
    controller.abort();
    server.close();
    await worker;
    log({ event: "stopped", runtimeId });
  }
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  try {
    await worker;
  } finally {
    server.close();
  }
}
try {
  await start();
} catch {
  log({ event: "startup_failed", errorCode: "CONFIG_OR_STARTUP_FAILED" });
  process.exitCode = 1;
}
