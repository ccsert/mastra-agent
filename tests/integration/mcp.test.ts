import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { runWorker } from "../../apps/runtime/src/worker.ts";
import { applicationSigner } from "../../packages/sdk/src/auth.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";
import { mcpFixture } from "../fixtures/mcp-fixture.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";

function defined<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out");
}

test("generated SDK → MCP discovery → explicit read-only import → published Mastra Agent; scope and revocation are fenced", {
  timeout: 40000,
}, async () => {
  const schema = `test_mcp_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    store = new Platform(db, new Vault("f1".repeat(32)));
  await store.initialize();
  const { app, mcp, queue } = createApp(store, {
    origin: "http://console.invalid",
    runtimeToken: "mcp-runtime-token",
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`,
    fixture = await mcpFixture(),
    modelFixture = await startModelFixture(0, {
      toolArguments: { orderId: "ORD-1001" },
      answer: "合成订单 ORD-1001 待发货，金额 12800。",
    }),
    controller = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const client = createClient({ baseUrl, throwOnError: true });
    const setup = await sdk.setupPlatform({
      client,
      body: { username: "owner", password: "test-password-123", workspaceName: "MCP" },
    });
    const actor = defined(setup.data),
      cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    const project = defined((await sdk.createProject({ client, body: { name: "MCP" } })).data),
      path = { projectId: project.id };
    const registered = defined(
        (
          await sdk.createMcpServer({
            client,
            path,
            body: { name: "合成订单", url: fixture.url, bearerToken: "mcp-fixture-key" },
          })
        ).data,
      ),
      servicePath = { ...path, id: registered.id };
    assert.equal(registered.hasCredential, true);
    assert.ok(!JSON.stringify(registered).includes("mcp-fixture-key"));
    const other = defined((await sdk.createProject({ client, body: { name: "Other" } })).data);
    const forbidden = await sdk.listMcpDiscoveries({
      client,
      path: { projectId: other.id, id: registered.id },
      throwOnError: false,
    });
    assert.equal(forbidden.response?.status, 404);
    const appCredential = defined(
      (await sdk.createApplication({ client, path, body: { name: "Business" } })).data,
    );
    const appClient = createClient({ baseUrl });
    appClient.interceptors.request.use(
      applicationSigner({
        appId: appCredential.id,
        accessKey: appCredential.accessKey,
        secretKey: appCredential.secretKey,
      }),
    );
    assert.equal((await sdk.listMcpServers({ client: appClient, path })).response?.status, 403);
    await sdk.discoverMcpTools({ client, path: servicePath, body: {} });
    const pending = defined(
      (await sdk.discoverMcpTools({ client, path: servicePath, body: {} })).data,
    );
    assert.equal((await sdk.listMcpDiscoveries({ client, path: servicePath })).data?.length, 1);
    worker = runWorker({
      controlPlaneUrl: baseUrl,
      runtimeId: store.runtimeId,
      runtimeToken: "mcp-runtime-token",
      signal: controller.signal,
    });
    const discoveries = await waitFor(
      async () => defined((await sdk.listMcpDiscoveries({ client, path: servicePath })).data),
      (v) => v[0].status === "succeeded" || v[0].status === "failed",
    );
    const discovery = discoveries[0];
    assert.equal(discovery.status, "succeeded");
    assert.equal(discovery.id, pending.id);
    assert.equal(discovery.tools.length, 2);
    assert.equal(fixture.calls.length, 0);
    const tool = defined(
      (
        await sdk.importMcpTool({
          client,
          path: servicePath,
          body: {
            discoveryId: discovery.id,
            remoteName: "orders_lookup",
            name: "orders_query",
            confirmedReadOnly: true,
          },
        })
      ).data,
    );
    const same = defined(
      (
        await sdk.importMcpTool({
          client,
          path: servicePath,
          body: {
            discoveryId: discovery.id,
            remoteName: "orders_lookup",
            name: "orders_query",
            confirmedReadOnly: true,
          },
        })
      ).data,
    );
    assert.equal(same.id, tool.id);
    assert.equal((await sdk.listTools({ client, path })).data?.length, 1);
    const alias = defined(
      (
        await sdk.importMcpTool({
          client,
          path: servicePath,
          body: {
            discoveryId: discovery.id,
            remoteName: "orders_lookup",
            name: "orders_query_alias",
            confirmedReadOnly: true,
          },
        })
      ).data,
    );
    assert.notEqual(alias.id, tool.id);
    assert.equal(alias.name, "orders_query_alias");
    assert.equal(alias.mcp?.contractDigest, tool.mcp?.contractDigest);
    const model = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "Protocol",
            modelId: "protocol-fixture",
            baseUrl: `${modelFixture.url}/v1`,
            apiKey: "fixture-key",
          },
        })
      ).data,
    );
    const agent = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "订单助手",
            modelId: model.id,
            instructions: "查询订单",
            toolIds: [tool.id],
          },
        })
      ).data,
    );
    const release = defined(
      (
        await sdk.publishAgent({
          client,
          path: { ...path, id: agent.id },
          body: { baseRevision: 1 },
        })
      ).data,
    );
    assert.ok(!JSON.stringify(release).includes("mcp-fixture-key"));
    assert.ok(release.snapshot.tools[0].mcp?.contractDigest);
    const conversation = defined(
      (await sdk.createConversation({ client: appClient, path, body: { agentId: agent.id } })).data,
    );
    const run = defined(
      (
        await sdk.createRun({
          client: appClient,
          path,
          body: {
            conversationId: conversation.id,
            input: "查询 ORD-1001",
            requestId: randomUUID(),
          },
        })
      ).data,
    );
    const result = await waitFor(
      async () =>
        defined((await sdk.getRun({ client: appClient, path: { ...path, id: run.id } })).data),
      (v) => !["queued", "running"].includes(v.status),
    );
    assert.equal(result.status, "succeeded");
    assert.match(result.outputText ?? "", /12800/);
    assert.deepEqual(fixture.calls[0], {
      name: "orders_lookup",
      arguments: { orderId: "ORD-1001" },
    });
    const events = defined(
      (await sdk.listRunEvents({ client: appClient, path: { ...path, id: run.id } })).data,
    );
    assert.match(JSON.stringify(events), /GPU-A5000-24/);
    assert.ok(!JSON.stringify(events).includes("mcp-fixture-key"));
    for (const failure of ["MCP_CONTRACT_CHANGED", "MCP_CONTENT_UNSUPPORTED"]) {
      fixture.state.changed = failure === "MCP_CONTRACT_CHANGED";
      fixture.state.media = failure === "MCP_CONTENT_UNSUPPORTED";
      const failedRun = defined(
        (
          await sdk.createRun({
            client: appClient,
            path,
            body: {
              conversationId: conversation.id,
              input: "查询 ORD-1001",
              requestId: randomUUID(),
            },
          })
        ).data,
      );
      const failed = await waitFor(
        async () =>
          defined(
            (await sdk.getRun({ client: appClient, path: { ...path, id: failedRun.id } })).data,
          ),
        (v) => !["queued", "running"].includes(v.status),
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, failure);
      assert.match(
        JSON.stringify(
          (await sdk.listRunEvents({ client: appClient, path: { ...path, id: failedRun.id } }))
            .data,
        ),
        new RegExp(failure),
      );
    }
    fixture.state.changed = false;
    fixture.state.media = false;
    // Stop auto-claiming so lease and policy boundaries can be tested deterministically.
    controller.abort();
    await worker;
    const next = await store.conversations.createRun(
      actor,
      project.id,
      (await store.conversations.create(actor, project.id, agent.id, "Lease")).id,
      "query",
      randomUUID(),
    );
    const job = await queue.claim();
    assert.equal(job?.runId, next.id);
    assert.ok(job);
    assert.equal(job.credentials.toolTokens[tool.id], undefined);
    assert.equal(
      (await mcp.authorize(next.id, job.leaseToken, tool.id)).bearerToken,
      "mcp-fixture-key",
    );
    await assert.rejects(() => mcp.authorize(next.id, job.leaseToken, randomUUID()), /未绑定/);
    await mcp.update(actor, project.id, registered.id, { bearerToken: "rotated" });
    assert.equal((await mcp.authorize(next.id, job.leaseToken, tool.id)).bearerToken, "rotated");
    await mcp.update(actor, project.id, registered.id, { enabled: false });
    await assert.rejects(() => mcp.authorize(next.id, job.leaseToken, tool.id), /停用/);
    await assert.rejects(() => store.agents.publish(actor, project.id, agent.id, 1), /停用/);
    await mcp.update(actor, project.id, registered.id, { enabled: true });
    await store.conversations.cancel(actor, project.id, next.id);
    await assert.rejects(() => mcp.authorize(next.id, job.leaseToken, tool.id), /取消/);
    await mcp.discover(actor, project.id, registered.id);
    const discoveryJob = await mcp.claim();
    assert.ok(discoveryJob);
    await mcp.update(actor, project.id, registered.id, { enabled: false });
    await assert.rejects(
      () =>
        mcp.finish(discoveryJob.id, {
          leaseToken: discoveryJob.leaseToken,
          status: "succeeded",
          tools: [],
        }),
      /失效/,
    );
    // A transaction starting before the lease ends must still fail after waiting for a lock.
    await mcp.update(actor, project.id, registered.id, { enabled: true });
    await mcp.discover(actor, project.id, registered.id);
    const late = await mcp.claim();
    assert.ok(late);
    const lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM mcp_servers WHERE id=$1 FOR UPDATE", [registered.id]);
    await db.query(
      "UPDATE mcp_discoveries SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",
      [late.id],
    );
    const lateResult = assert.rejects(
      () => mcp.finish(late.id, { leaseToken: late.leaseToken, status: "succeeded", tools: [] }),
      /失效/,
    );
    await new Promise((r) => setTimeout(r, 200));
    await lock.query("COMMIT");
    lock.release();
    await lateResult;
  } finally {
    controller.abort();
    await worker;
    await fixture.close();
    await modelFixture.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
