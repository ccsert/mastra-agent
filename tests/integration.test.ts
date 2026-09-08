import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../apps/control-plane/src/app.ts";
import { Vault } from "../apps/control-plane/src/crypto.ts";
import { Platform } from "../apps/control-plane/src/platform.ts";
import { runWorker } from "../apps/runtime/src/worker.ts";
import { applicationSigner } from "../packages/sdk/src/auth.ts";
import { createClient } from "../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { required } from "../scripts/env.ts";
import { startModelFixture } from "./model-fixture.ts";

test("generated SDK → authenticated control plane → HTTP worker → Mastra tools → durable history", {
  timeout: 45000,
}, async () => {
  const schema = `test_http_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    store = new Platform(db, new Vault("cd".repeat(32)));
  await store.initialize();
  const { app, queue } = createApp(store, {
    origin: "http://127.0.0.1:5173",
    additionalOrigins: ["http://192.168.1.100:5179", "http://localhost:5179"],
    runtimeToken: "integration-runtime-token",
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not listening");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const fixture = await startModelFixture(),
    controller = new AbortController();
  const worker = runWorker({
    controlPlaneUrl: baseUrl,
    runtimeId: "hosted-local",
    runtimeToken: "integration-runtime-token",
    signal: controller.signal,
  });
  try {
    const client = createClient({ baseUrl, throwOnError: true });
    const setup = await sdk.setupPlatform({
      client,
      body: { username: "test-owner", password: "test-password-123", workspaceName: "Integration" },
    });
    const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    for (const origin of [
      "http://127.0.0.1:5173",
      "http://192.168.1.100:5179",
      "http://localhost:5179",
    ]) {
      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ username: "test-owner", password: "test-password-123" }),
      });
      assert.equal(login.status, 200, origin);
      assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/i);
      assert.match(login.headers.get("set-cookie") ?? "", /SameSite=Strict/i);
    }
    for (const origin of [
      "http://192.168.1.101:5179",
      "http://192.168.1.100:5180",
      "http://192.168.1.100.evil.invalid:5179",
      "null",
    ]) {
      const denied: Response = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ name: "Must not be created" }),
      });
      assert.equal(denied.status, 403, origin);
      assert.equal((await denied.json()).code, "ORIGIN_DENIED");
    }
    const spec = await fetch(`${baseUrl}/openapi.json`);
    assert.deepEqual((await spec.json()).servers, [{ url: "/" }]);
    const project = defined(
      (await sdk.createProject({ client, body: { name: "Integration project", description: "" } }))
        .data,
    );
    const path = { projectId: project.id };
    const model = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "协议测试模型",
            baseUrl: `${fixture.url}/v1`,
            modelId: "protocol-fixture",
            apiKey: "fixture-key",
          },
        })
      ).data,
    );
    const tool = defined(
      (
        await sdk.createTool({
          client,
          path,
          body: {
            name: "sum_values",
            description: "求和",
            kind: "sum",
            inputSchema: {},
            outputSchema: {},
          },
        })
      ).data,
    );
    await db.query(
      "UPDATE resources SET data=jsonb_set(jsonb_set(data,'{inputSchema,$id}',to_jsonb('https://example.invalid/sum-input'::text)),'{outputSchema,$id}',to_jsonb('https://example.invalid/sum-output'::text)) WHERE id=$1",
      [tool.id],
    );
    const agent = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "集成助手",
            instructions: "调用 sum_values 计算 40 与 80 的和。",
            modelId: model.id,
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
    assert.equal(release.version, 1);
    const conversation = defined(
      (
        await sdk.createConversation({
          client,
          path,
          body: { agentId: agent.id, title: "SDK conversation" },
        })
      ).data,
    );
    const run = defined(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: "请计算 40 和 80 的和",
            requestId: randomUUID(),
          },
        })
      ).data,
    );
    let finished = run;
    for (let i = 0; i < 120; i++) {
      finished = defined((await sdk.getRun({ client, path: { ...path, id: run.id } })).data);
      if (!["queued", "running"].includes(finished.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(finished.status, "succeeded", JSON.stringify(finished));
    assert.ok(finished.outputText?.includes("120"));
    assert.ok(fixture.calls >= 2);
    const events = defined(
      (await sdk.listRunEvents({ client, path: { ...path, id: run.id } })).data,
    );
    assert.ok(events.some((e) => e.chunk.type === "tool-output-available"));
    assert.ok(events.some((e) => e.chunk.type === "text-delta"));
    const messages = defined(
      (await sdk.listMessages({ client, path: { ...path, id: conversation.id } })).data,
    );
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, "assistant");
    const credential = defined(
      (await sdk.createApplication({ client, path, body: { name: "Order service" } })).data,
    );
    const application = createClient({ baseUrl, throwOnError: true });
    application.interceptors.request.use(
      applicationSigner({
        appId: credential.id,
        accessKey: credential.accessKey,
        secretKey: credential.secretKey,
      }),
    );
    const appConversation = defined(
      (
        await sdk.createConversation({
          client: application,
          path,
          body: { agentId: agent.id, title: "Application" },
        })
      ).data,
    );
    const forbidden = await sdk.listMessages({
      client: application,
      path: { ...path, id: conversation.id },
      throwOnError: false,
    });
    assert.equal(forbidden.response?.status, 404);
    const management = await sdk.createProject({
      client: application,
      body: { name: "Forbidden" },
      throwOnError: false,
    });
    assert.equal(management.response?.status, 403);
    const appRun = defined(
      (
        await sdk.createRun({
          client: application,
          path,
          body: { conversationId: appConversation.id, input: "再次计算", requestId: randomUUID() },
        })
      ).data,
    );
    assert.ok(appRun.id);
    let appFinished = appRun;
    for (let i = 0; i < 100; i++) {
      appFinished = defined(
        (await sdk.getRun({ client: application, path: { ...path, id: appRun.id } })).data,
      );
      if (!["queued", "running"].includes(appFinished.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(appFinished.status, "succeeded");
    const signed = await applicationSigner({
      appId: credential.id,
      accessKey: credential.accessKey,
      secretKey: credential.secretKey,
    })(new Request(`${baseUrl}/api/v1/projects`));
    assert.equal((await fetch(signed.clone())).status, 200);
    assert.equal((await fetch(signed.clone())).status, 401);
    await sdk.revokeApplication({ client, path: { ...path, id: credential.id }, body: {} });
    const revoked = await sdk.listProjects({ client: application, throwOnError: false });
    assert.equal(revoked.response?.status, 401);
    const runtimeDenied = await fetch(`${baseUrl}/internal/runtime/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(runtimeDenied.status, 401);
    const invalidTool = await sdk.createTool({
      client,
      path,
      body: {
        name: "invalid_tool",
        description: "Bad schema",
        kind: "http_get",
        url: fixture.url,
        inputSchema: { type: "object", properties: { x: { type: "not-a-type" } } },
        outputSchema: {},
      },
      throwOnError: false,
    });
    assert.equal(invalidTool.response?.status, 400);
    const invalidModel = await sdk.createModel({
      client,
      path,
      body: { name: "Bad URL", baseUrl: "invalid", modelId: "test" },
      throwOnError: false,
    });
    assert.equal(invalidModel.response?.status, 400);
    async function runWithModel(modelId: string, apiKey: string) {
      const model = defined(
        (
          await sdk.createModel({
            client,
            path,
            body: { name: modelId, baseUrl: `${fixture.url}/v1`, modelId, apiKey },
          })
        ).data,
      );
      const agent = defined(
        (
          await sdk.createAgent({
            client,
            path,
            body: { name: modelId, instructions: "Test response", modelId: model.id, toolIds: [] },
          })
        ).data,
      );
      await sdk.publishAgent({
        client,
        path: { ...path, id: agent.id },
        body: { baseRevision: 1 },
      });
      const thread = defined(
        (await sdk.createConversation({ client, path, body: { agentId: agent.id } })).data,
      );
      return defined(
        (
          await sdk.createRun({
            client,
            path,
            body: { conversationId: thread.id, input: "Test", requestId: randomUUID() },
          })
        ).data,
      );
    }
    async function waitFor(run: sdk.Run, statuses: string[]) {
      for (let i = 0; i < 200; i++) {
        const current = defined((await sdk.getRun({ client, path: { ...path, id: run.id } })).data);
        if (statuses.includes(current.status)) return current;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Run status timeout");
    }
    const broken = await runWithModel("bad-credential", "wrong");
    assert.equal((await waitFor(broken, ["failed"])).errorCode, "MODEL_ERROR");
    const slow = await runWithModel("slow-fixture", "fixture-key");
    await waitFor(slow, ["running"]);
    await sdk.cancelRun({ client, path: { ...path, id: slow.id }, body: {} });
    assert.equal((await waitFor(slow, ["cancelled"])).status, "cancelled");
    assert.equal(
      (await sdk.listMessages({ client, path: { ...path, id: slow.conversationId } })).data?.length,
      1,
    );
    await queue.reap();
  } finally {
    controller.abort();
    await worker;
    await fixture.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});

function defined<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
