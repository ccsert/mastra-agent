import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createLogger, localConsoleOrigins, required } from "@platform/operations";
import { createApp } from "./app.ts";
import { Vault } from "./crypto.ts";
import { Platform } from "./platform.ts";

const log = createLogger("control-plane");
async function start() {
  const origin = required("CONSOLE_ORIGIN"),
    runtimeToken = required("RUNTIME_TOKEN"),
    vault = new Vault(required("ENCRYPTION_KEY")),
    db = new Database(required("DATABASE_URL"), process.env.DATABASE_SCHEMA ?? "public");
  const platform = new Platform(db, vault, process.env.RUNTIME_ID ?? "hosted-local");
  try {
    await platform.initialize();
  } catch (error) {
    await db.close();
    throw error;
  }
  const { app, queue, knowledge, mcp, workflowQueue } = createApp(platform, {
    origin,
    runtimeToken,
    logger: log,
    additionalOrigins: () => [
      ...(process.env.CONSOLE_ADDITIONAL_ORIGINS?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      ...(process.env.CONSOLE_LOCAL_ORIGINS === "true"
        ? localConsoleOrigins(
            process.env.CONSOLE_HOST ?? "0.0.0.0",
            Number(process.env.CONSOLE_PORT ?? 5179),
          )
        : []),
    ],
    secureCookie: process.env.COOKIE_SECURE === "true",
  });
  let cleaning: Promise<unknown> | undefined,
    stopping = false;
  const timer = setInterval(() => {
    if (!cleaning)
      cleaning = Promise.allSettled([
        queue.reap(),
        knowledge.reap(),
        mcp.reap(),
        workflowQueue.reap(),
      ])
        .then((results) => {
          if (results.some((result) => result.status === "rejected"))
            log({ event: "cleanup_failed", errorCode: "JOB_CLEANUP_FAILED" });
        })
        .finally(() => {
          cleaning = undefined;
        });
  }, 5000);
  const server = serve(
    {
      fetch: app.fetch,
      hostname: process.env.API_HOST ?? "127.0.0.1",
      port: Number(process.env.API_PORT ?? 4110),
    },
    () => log({ event: "started" }),
  );
  try {
    await once(server, "listening");
  } catch (error) {
    clearInterval(timer);
    await db.close();
    throw error;
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    log({ event: "stopping" });
    clearInterval(timer);
    const timeout = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, 15000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(timeout);
    await cleaning;
    await db.close();
    log({ event: "stopped" });
  }
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
try {
  await start();
} catch {
  log({ event: "startup_failed", errorCode: "CONFIG_OR_STARTUP_FAILED" });
  process.exitCode = 1;
}
