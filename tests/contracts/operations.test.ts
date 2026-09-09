import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { runtimeClient } from "../../apps/runtime/src/control-plane/client.ts";
import { ControlConnection } from "../../apps/runtime/src/control-plane/connection.ts";
import { createLogger } from "../../packages/operations/src/index.ts";
import { required } from "../../scripts/env.ts";

test("request diagnostics correlate authentication errors without logging payloads, paths or credentials", async () => {
  const schema = `test_operations_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    platform = new Platform(db, new Vault("ad".repeat(32)));
  await platform.initialize();
  const logs: string[] = [],
    logger = createLogger("control-plane", (line) => logs.push(line));
  const { app } = createApp(platform, {
    origin: "http://localhost",
    runtimeToken: "valid-secret",
    logger,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const post = runtimeClient({
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      runtimeId: "hosted-local",
      runtimeToken: "PRIVATE_TOKEN",
      signal: new AbortController().signal,
      logger: createLogger("runtime", (line) => logs.push(line)),
    });
    await assert.rejects(
      post("/internal/runtime/claim", { secret: "PRIVATE_BODY" }),
      /CONTROL_PLANE_401/,
    );
    const entries = logs.map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].requestId, entries[1].requestId);
    assert.equal(entries[0].status, 401);
    const response = await app.request("/PRIVATE_PATH?secret=PRIVATE_QUERY", {
      headers: { cookie: "PRIVATE_COOKIE", "x-request-id": "invalid.id" },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(logs.at(-1) ?? "{}").route, "unmatched");
    assert.ok(!logs.join("").includes("PRIVATE_"));
    assert.equal((await app.request("/ready")).status, 200);
    await db.close();
    assert.equal((await app.request("/ready")).status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!db.pool.ended) await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});

test("Runtime readiness expires, rejects lost authorization and recovers after authenticated contact", () => {
  let now = 0;
  const connection = new ControlConnection(() => now);
  assert.equal(connection.snapshot().status, "unavailable");
  connection.record(200);
  assert.equal(connection.snapshot().status, "ready");
  connection.record(409); // A job-specific lease conflict is not a broken control connection.
  assert.equal(connection.snapshot().status, "ready");
  connection.record(401);
  assert.equal(connection.snapshot().status, "unavailable");
  connection.record(200);
  now = 15001;
  assert.equal(connection.snapshot().status, "unavailable");
  connection.record(200);
  assert.equal(connection.snapshot().status, "ready");
  connection.record(0);
  assert.equal(connection.snapshot().status, "unavailable");
});
