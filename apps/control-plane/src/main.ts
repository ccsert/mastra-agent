import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { required } from "../../../scripts/env.ts";
import { createApp } from "./app.ts";
import { Vault } from "./crypto.ts";
import { Store } from "./store.ts";

const db = new Database(required("DATABASE_URL"), process.env.DATABASE_SCHEMA ?? "public");
const store = new Store(
  db,
  new Vault(required("ENCRYPTION_KEY")),
  process.env.RUNTIME_ID ?? "hosted-local",
);
await store.initialize();
const { app, queue, knowledge, mcp, workflowQueue } = createApp(store, {
  origin: required("CONSOLE_ORIGIN"),
  additionalOrigins: process.env.CONSOLE_ADDITIONAL_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  runtimeToken: required("RUNTIME_TOKEN"),
  secureCookie: process.env.COOKIE_SECURE === "true",
});
const timer = setInterval(
  () =>
    void Promise.all([queue.reap(), knowledge.reap(), mcp.reap(), workflowQueue.reap()]).catch(() =>
      console.error("Job cleanup failed"),
    ),
  5000,
);
const server = serve(
  {
    fetch: app.fetch,
    hostname: process.env.API_HOST ?? "127.0.0.1",
    port: Number(process.env.API_PORT ?? 4110),
  },
  (info) => console.log(`Control plane ready on ${info.port}`),
);
async function stop() {
  clearInterval(timer);
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
