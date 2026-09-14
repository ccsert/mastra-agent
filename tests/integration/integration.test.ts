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
import {
  ModelRequestTiming,
  ModelStep,
  RunUsage,
  ToolExecution,
  ToolExecutionStart,
} from "../../packages/contracts/src/index.ts";
import { applicationSigner } from "../../packages/sdk/src/auth.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";

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
  const fixture = await startModelFixture(0, { reasoning: "先检查工具结果，再组织最终答复。" }),
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
    let localOrigins = ["http://192.168.50.31:5179"];
    const liveApp = createApp(store, {
      origin: "http://127.0.0.1:5179",
      additionalOrigins: () => ["http://console.example:5179", ...localOrigins],
      runtimeToken: "integration-runtime-token",
    }).app;
    const loginFrom = (origin: string) =>
      liveApp.request("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ username: "test-owner", password: "test-password-123" }),
      });
    assert.equal((await loginFrom("http://192.168.50.31:5179")).status, 200);
    localOrigins = ["http://192.168.110.151:5179"];
    for (const origin of [
      "http://127.0.0.1:5179",
      "http://console.example:5179",
      "http://192.168.110.151:5179",
    ]) {
      const login = await loginFrom(origin);
      assert.equal(login.status, 200, origin);
      const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
      assert.ok(sessionCookie);
      assert.equal(
        (await liveApp.request("/api/v1/me", { headers: { cookie: sessionCookie } })).status,
        200,
      );
    }
    for (const origin of [
      "http://192.168.50.31:5179",
      "http://192.168.110.152:5179",
      "http://192.168.110.151:5180",
      "https://192.168.110.151:5179",
      "http://192.168.110.151.evil.invalid:5179",
      "null",
    ]) {
      const denied = await loginFrom(origin);
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
    assert.ok(events.some((e) => e.chunk.type === "reasoning-delta"));
    const requests = events.filter((e) => e.chunk.type === "data-model-request");
    assert.deepEqual(
      requests.map((e) => (e.chunk.data as { stepIndex: number }).stepIndex),
      [0, 1],
    );
    assert.ok(events.some((e) => e.observation?.type === "data-model-response"));
    assert.ok(
      requests.every(
        (e) =>
          (e.chunk.data as { request: { stream_options?: { include_usage?: boolean } } }).request
            .stream_options?.include_usage === true,
      ),
    );
    const trace = defined(
      (await sdk.getConversationTrace({ client, path: { ...path, id: run.conversationId } })).data,
    );
    const traceTurn = trace.turns.find((t) => t.run.id === run.id);
    assert.ok(traceTurn?.checkpoint);
    assert.equal(traceTurn.checkpoint.eventCount, events.length);
    assert.equal(traceTurn.checkpoint.lastSeq, events.at(-1)?.seq);
    assert.equal(traceTurn.messages?.length, 2);
    assert.ok(
      traceTurn.messages.some(
        (m) => m.role === "assistant" && m.parts.some((p) => p.type === "reasoning"),
      ),
    );
    const bounded = defined(
      (
        await sdk.listRunEvents({
          client,
          path: { ...path, id: run.id },
          query: { after: 1, through: 3 },
        })
      ).data,
    );
    assert.deepEqual(
      bounded.map((e) => e.seq),
      [2, 3],
    );
    // Collection facts added in P0: every event carries the runtime's own clock, and
    // transport timing, tool execution and provider usage are recorded rather than inferred.
    assert.ok(events.every((e) => e.timeSource === "runtime" && e.occurredAt.length > 0));
    const responses = events.filter((e) => e.chunk.type === "data-model-response");
    assert.equal(responses.length, fixture.calls);
    for (const response of responses) {
      const timing = ModelRequestTiming.parse(response.chunk.data);
      assert.equal(timing.outcome, "completed");
      assert.equal(timing.httpStatus, 200);
      assert.ok(timing.responseBytes > 0);
      assert.ok(timing.firstByteMs !== null && timing.firstByteMs >= 0);
      assert.ok(timing.durationMs >= timing.firstByteMs);
    }
    const executions = events.filter((e) => e.chunk.type === "data-tool-execution");
    assert.equal(executions.length, 1);
    const execution = ToolExecution.parse(executions[0]?.chunk.data);
    assert.equal(execution.toolName, "sum_values");
    assert.equal(execution.source, "sum");
    assert.equal(execution.outcome, "succeeded");
    assert.ok(execution.durationMs >= 0);
    assert.ok(execution.toolCallId.length > 0);
    // The execution is joined to the model's own call id, not to stream order.
    const streamed = events.find((e) => e.chunk.type === "tool-input-available");
    assert.equal(execution.toolCallId, streamed?.chunk.toolCallId);
    const startedEvent = events.find((e) => e.observation?.type === "data-tool-start");
    assert.ok(startedEvent);
    const started = ToolExecutionStart.parse(startedEvent.chunk.data);
    assert.equal(started.toolCallId, execution.toolCallId);
    assert.equal(started.startedAt, execution.startedAt);
    assert.ok(startedEvent.seq < executions[0].seq);
    const usageEvent = events.find((e) => e.chunk.type === "data-run-usage");
    assert.ok(usageEvent);
    const usage = RunUsage.parse(usageEvent.chunk.data);
    assert.ok(usage.steps >= 2);
    assert.equal(usage.perStep.length, usage.steps);
    // The fixture reports usage the way an OpenAI-compatible provider does: 128
    // tokens per call. The run total is the sum over its steps, never a single call.
    assert.equal(usage.usage.totalTokens, 128 * usage.steps);
    assert.equal(usage.usage.inputTokens, 120 * usage.steps);
    assert.equal(usage.usage.outputTokens, 8 * usage.steps);
    assert.ok(usage.perStep.every((step) => step.usage.totalTokens === 128));
    assert.ok(usage.perStep.every((step) => step.modelId !== null));
    const generationEvents = events.filter((e) => e.observation?.type === "data-model-step");
    const generations = generationEvents.map((e) => ModelStep.parse(e.chunk.data));
    assert.deepEqual(
      generations.map((s) => s.stepIndex),
      [0, 1],
    );
    assert.ok(generations.every((s) => s.usage.totalTokens === 128));
    assert.equal(generations[0].finishReason, "tool-calls");
    assert.equal(generations[1].finishReason, "stop");
    // The first generation is durable before the second request starts, not just at run finish.
    assert.ok(generationEvents[0].seq < requests[1].seq);
    // Probing and editing a model: verify before saving, and fix a mistake afterwards.
    const draft = { kind: "chat" as const, baseUrl: `${fixture.url}/v1`, modelId: model.modelId };
    const probed = defined(
      (
        await sdk.probeModel({
          client,
          path,
          body: { ...draft, apiKey: "fixture-key" },
        })
      ).data,
    );
    assert.equal(probed.outcome, "ok");
    assert.equal(probed.httpStatus, 200);
    assert.ok((probed.latencyMs ?? -1) >= 0);
    // A reachable service that refuses the credential is not the same as an unreachable one.
    const refused = defined(
      (await sdk.probeModel({ client, path, body: { ...draft, apiKey: "wrong-key" } })).data,
    );
    assert.equal(refused.outcome, "rejected");
    assert.equal(refused.httpStatus, 401);
    assert.match(refused.message, /Invalid fixture credential/);
    const unreachable = defined(
      (
        await sdk.probeModel({
          client,
          path,
          body: { ...draft, baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key" },
        })
      ).data,
    );
    assert.equal(unreachable.outcome, "unreachable");
    assert.equal(unreachable.httpStatus, null);
    const embedded = defined(
      (
        await sdk.probeModel({
          client,
          path,
          body: { ...draft, kind: "embedding", apiKey: "fixture-key" },
        })
      ).data,
    );
    assert.equal(embedded.outcome, "ok");
    assert.equal(embedded.dimensions, 8);
    // A width the service does not actually return is caught before anything is saved.
    const widthMismatch = defined(
      (
        await sdk.probeModel({
          client,
          path,
          body: { ...draft, kind: "embedding", apiKey: "fixture-key", dimensions: 1024 },
        })
      ).data,
    );
    assert.equal(widthMismatch.outcome, "rejected");
    assert.match(widthMismatch.message, /1024/);
    // The saved credential can be reused without the browser ever seeing it again.
    const reused = defined(
      (await sdk.probeModel({ client, path, body: { ...draft, credentialFrom: model.id } })).data,
    );
    assert.equal(reused.outcome, "ok");
    // Discovery reads the ids the service advertises so an operator picks from
    // real options. The fixture answers unsorted with a duplicate.
    const discovered = defined(
      (
        await sdk.discoverModels({
          client,
          path,
          body: { baseUrl: draft.baseUrl, credentialFrom: model.id },
        })
      ).data,
    );
    assert.equal(discovered.outcome, "ok");
    assert.equal(discovered.httpStatus, 200);
    assert.deepEqual(discovered.models, ["fixture-chat", "fixture-embed"]);
    // A service without a catalogue endpoint is a normal deployment, not an error.
    const noCatalogue = defined(
      (
        await sdk.discoverModels({
          client,
          path,
          body: { baseUrl: `${fixture.url}/v1/embeddings`, apiKey: "fixture-key" },
        })
      ).data,
    );
    assert.equal(noCatalogue.outcome, "unsupported");
    assert.equal(noCatalogue.httpStatus, 404);
    assert.deepEqual(noCatalogue.models, []);
    // A refused credential is reported as rejected, distinguishing it from a
    // service that simply has no catalogue.
    const discoveryRefused = defined(
      (
        await sdk.discoverModels({
          client,
          path,
          body: { baseUrl: draft.baseUrl, apiKey: "wrong-key" },
        })
      ).data,
    );
    assert.equal(discoveryRefused.outcome, "rejected");
    assert.equal(discoveryRefused.httpStatus, 401);
    const discoveryUnreachable = defined(
      (
        await sdk.discoverModels({
          client,
          path,
          body: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key" },
        })
      ).data,
    );
    assert.equal(discoveryUnreachable.outcome, "unreachable");
    assert.deepEqual(discoveryUnreachable.models, []);
    // The vendor catalogue is static and includes the address of each preset.
    const vendors = defined((await sdk.listModelVendors({ client })).data);
    assert.ok(vendors.some((v) => v.vendor === "deepseek" && v.baseUrl?.includes("deepseek.com")));
    assert.ok(vendors.every((v) => v.note.length > 0));
    assert.equal(vendors.find((v) => v.vendor === "custom")?.baseUrl, null);
    // A vendor and declared capabilities survive a round trip and are readable back.
    const edited = defined(
      (
        await sdk.updateModel({
          client,
          path: { ...path, id: model.id },
          body: {
            ...draft,
            name: "协议测试模型（已改）",
            vendor: "deepseek",
            capabilities: { vision: true, toolUse: false },
          },
        })
      ).data,
    );
    assert.equal(edited.name, "协议测试模型（已改）");
    assert.equal(edited.vendor, "deepseek");
    assert.equal(edited.capabilities?.vision, true);
    assert.equal(edited.capabilities?.toolUse, false);
    // Omitting the key keeps the stored credential instead of clearing it.
    assert.equal(edited.hasCredential, true);
    // The body replaces the record, so an omitted vendor falls back to its default
    // rather than retaining the previous value; callers send the full object.
    const reset = defined(
      (
        await sdk.updateModel({
          client,
          path: { ...path, id: model.id },
          body: { ...draft, name: "协议测试模型" },
        })
      ).data,
    );
    assert.equal(reset.vendor, "custom");
    assert.equal(reset.capabilities?.toolUse, true);
    assert.equal(reset.hasCredential, true);
    const withoutCredential = defined(
      (
        await sdk.probeModel({
          client,
          path,
          body: { ...draft, kind: "embedding", credentialFrom: model.id },
        })
      ).data,
    );
    assert.equal(withoutCredential.outcome, "ok");
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
    // Management endpoints stay closed to application credentials, which exist to
    // call a published Agent rather than to browse configuration.
    const appVendors = await sdk.listModelVendors({ client: application, throwOnError: false });
    assert.equal(appVendors.response?.status, 403);
    const appModels = await sdk.listModels({
      client: application,
      path,
      throwOnError: false,
    });
    assert.equal(appModels.response?.status, 403);
    const appDiscovery = await sdk.discoverModels({
      client: application,
      path,
      body: { baseUrl: `${fixture.url}/v1`, apiKey: "fixture-key" },
      throwOnError: false,
    });
    assert.equal(appDiscovery.response?.status, 403);
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
    // A model declared as unable to call tools cannot back an Agent that binds
    // tools or knowledge: the declaration has to change behaviour, not just be
    // stored, or it would be worse than not recording it at all.
    const noTools = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "无工具模型",
            baseUrl: `${fixture.url}/v1`,
            modelId: "protocol-fixture",
            apiKey: "fixture-key",
            capabilities: { toolUse: false },
          },
        })
      ).data,
    );
    assert.equal(noTools.capabilities?.toolUse, false);
    const rejectedAgent = await sdk.createAgent({
      client,
      path,
      body: {
        name: "越权助手",
        instructions: "调用工具",
        modelId: noTools.id,
        toolIds: [tool.id],
      },
      throwOnError: false,
    });
    assert.equal(rejectedAgent.response?.status, 400);
    assert.equal(rejectedAgent.error?.code, "MODEL_TOOL_USE");
    const rejectedSupervisor = await sdk.createAgent({
      client,
      path,
      body: {
        name: "无工具模型不能委派",
        instructions: "委派任务",
        modelId: noTools.id,
        toolIds: [],
        delegation: { enabled: true, maxCalls: 2, maxParallel: 1, maxSteps: 2 },
      },
      throwOnError: false,
    });
    assert.equal(rejectedSupervisor.response?.status, 400);
    assert.equal(rejectedSupervisor.error?.code, "MODEL_TOOL_USE");
    const rejectedPlanner = await sdk.createAgent({
      client,
      path,
      body: {
        name: "无工具模型不能记录计划",
        instructions: "计划",
        modelId: noTools.id,
        toolIds: [],
        planningEnabled: true,
      },
      throwOnError: false,
    });
    assert.equal(rejectedPlanner.response?.status, 400);
    assert.equal(rejectedPlanner.error?.code, "MODEL_TOOL_USE");
    // The same model is accepted once nothing tool-based is bound to it.
    const plainAgent = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "纯对话助手",
            instructions: "只回答",
            modelId: noTools.id,
            toolIds: [],
          },
        })
      ).data,
    );
    assert.equal(plainAgent.modelId, noTools.id);
    async function runWithModel(
      modelId: string,
      apiKey: string,
      delegation?: sdk.AgentInput["delegation"],
    ) {
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
            body: {
              name: modelId,
              instructions: "Test response",
              modelId: model.id,
              toolIds: [],
              delegation,
            },
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
    const planningFixture = await startModelFixture(0, {
      toolSequence: [
        {
          name: "update_plan",
          input: {
            baseRevision: 0,
            title: "核对订单",
            explanation: "先计算再核对",
            items: [{ id: "sum", title: "计算金额", status: "in_progress" }],
          },
        },
        { name: "sum_values", input: { values: [3, 7] } },
        {
          name: "update_plan",
          input: {
            baseRevision: 1,
            title: "核对订单",
            explanation: "依据 sum_values 返回金额 10",
            items: [
              { id: "sum", title: "计算金额", status: "completed", detail: "真实工具结果 10" },
            ],
          },
        },
      ],
    });
    try {
      const planningModel = defined(
        (
          await sdk.createModel({
            client,
            path,
            body: {
              name: "计划验收模型",
              baseUrl: `${planningFixture.url}/v1`,
              modelId: "planning-fixture",
              apiKey: "fixture-key",
            },
          })
        ).data,
      );
      const planner = defined(
        (
          await sdk.createAgent({
            client,
            path,
            body: {
              name: "计划验收",
              instructions: "按计划核对",
              modelId: planningModel.id,
              toolIds: [tool.id],
              planningEnabled: true,
              maxSteps: 5,
            },
          })
        ).data,
      );
      const release = defined(
        (
          await sdk.publishAgent({
            client,
            path: { ...path, id: planner.id },
            body: { baseRevision: 1 },
          })
        ).data,
      );
      assert.equal(release.snapshot.agent.planningEnabled, true);
      const conversation = defined(
        (await sdk.createConversation({ client, path, body: { agentId: planner.id } })).data,
      );
      const run = defined(
        (
          await sdk.createRun({
            client,
            path,
            body: {
              conversationId: conversation.id,
              input: "核对 3 与 7",
              requestId: randomUUID(),
            },
          })
        ).data,
      );
      assert.equal((await waitFor(run, ["succeeded", "failed"])).status, "succeeded");
      const events = defined(
        (await sdk.listRunEvents({ client, path: { ...path, id: run.id } })).data,
      );
      const plans = events.flatMap((e) =>
        e.observation?.type === "data-task-plan" ? [e.observation.data] : [],
      );
      assert.equal(plans.length, 2);
      assert.deepEqual(
        plans.map((p) => p.revision),
        [1, 2],
      );
      assert.deepEqual(
        plans.map((p) => p.items[0]?.status),
        ["in_progress", "completed"],
      );
      assert.equal(new Set(plans.map((p) => p.toolCallId)).size, 2);
      for (const plan of plans)
        assert.ok(
          events.some(
            (e) =>
              e.observation?.type === "data-tool-execution" &&
              e.observation.data.toolCallId === plan.toolCallId &&
              e.observation.data.source === "planning",
          ),
        );
      assert.ok(planningFixture.toolResults.some((value) => String(value).includes('"total":10')));
    } finally {
      await planningFixture.close();
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
    const childModel = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "子代理模型",
            baseUrl: `${fixture.url}/v1`,
            modelId: "delegation-fixture",
            apiKey: "fixture-key",
          },
        })
      ).data,
    );
    const supervisor = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "委派验收",
            instructions: "将工作拆为独立子任务并汇总结果",
            modelId: childModel.id,
            toolIds: [tool.id],
            delegation: { enabled: true, maxCalls: 2, maxParallel: 2, maxSteps: 3 },
          },
        })
      ).data,
    );
    const supervisorRelease = defined(
      (
        await sdk.publishAgent({
          client,
          path: { ...path, id: supervisor.id },
          body: { baseRevision: 1 },
        })
      ).data,
    );
    assert.equal(supervisorRelease.snapshot.agent.delegation?.maxCalls, 2);
    const childConversation = defined(
      (await sdk.createConversation({ client, path, body: { agentId: supervisor.id } })).data,
    );
    const childRoot = defined(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: childConversation.id,
            input: "两个子代理核对订单",
            requestId: randomUUID(),
          },
        })
      ).data,
    );
    assert.equal((await waitFor(childRoot, ["succeeded", "failed"])).status, "succeeded");
    const childEvents = defined(
      (await sdk.listRunEvents({ client, path: { ...path, id: childRoot.id } })).data,
    );
    const states = childEvents.flatMap((e) =>
      e.observation?.type === "data-subagent" ? [e.observation.data] : [],
    );
    const succeeded = states.filter((s) => s.status === "succeeded");
    assert.equal(succeeded.length, 2);
    assert.equal(new Set(succeeded.map((s) => s.id)).size, 2);
    assert.equal(new Set(succeeded.map((s) => s.parentToolCallId)).size, 2);
    for (const state of succeeded) {
      assert.equal(state.parentRunId, childRoot.id);
      assert.deepEqual(state.allowedTools, ["sum_values"]);
      const nested = childEvents.flatMap((e) =>
        e.observation?.type === "data-subagent-event" && e.observation.data.id === state.id
          ? [e.observation.data]
          : [],
      );
      assert.ok(nested.every((e) => e.parentToolCallId === state.parentToolCallId));
      assert.equal(nested.filter((e) => e.chunk.type === "data-model-request").length, 2);
      const toolObservation = nested.find(
        (e) => e.observation?.type === "data-tool-execution",
      )?.observation;
      assert.equal(toolObservation?.type, "data-tool-execution");
      if (toolObservation?.type === "data-tool-execution")
        assert.equal(toolObservation.data.toolCallId, "same-child-call-id");
      const childUsage = nested.find((e) => e.observation?.type === "data-run-usage")?.observation;
      if (childUsage?.type !== "data-run-usage") throw new Error("Child usage missing");
      assert.equal(childUsage.data.usage.totalTokens, 256);
      // No child receives the delegation tool, so recursion cannot be requested.
      assert.ok(
        nested
          .filter((e) => e.chunk.type === "data-model-request")
          .every((e) => !JSON.stringify(e.chunk.data).includes('"name":"delegate_task"')),
      );
    }
    assert.equal(
      childEvents
        .filter((e) => e.chunk.type === "text-delta")
        .map((e) => e.chunk.delta)
        .join("")
        .includes("120"),
      true,
    );
    const slowChildren = await runWithModel("delegation-slow-fixture", "fixture-key", {
      enabled: true,
      maxCalls: 2,
      maxParallel: 1,
      maxSteps: 2,
    });
    let hasRunningAndQueued = false;
    for (let i = 0; i < 100; i++) {
      const events = defined(
        (await sdk.listRunEvents({ client, path: { ...path, id: slowChildren.id } })).data,
      );
      const childStates = events.flatMap((e) =>
        e.observation?.type === "data-subagent" ? [e.observation.data] : [],
      );
      if (
        childStates.filter((s) => s.status === "queued").length === 2 &&
        childStates.some((s) => s.status === "running")
      ) {
        hasRunningAndQueued = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(hasRunningAndQueued, "one child must be running while the other waits");
    await sdk.cancelRun({ client, path: { ...path, id: slowChildren.id }, body: {} });
    assert.equal((await waitFor(slowChildren, ["cancelled", "failed"])).status, "cancelled");
    const cancelledEvents = defined(
      (await sdk.listRunEvents({ client, path: { ...path, id: slowChildren.id } })).data,
    );
    const cancelledChildren = cancelledEvents.flatMap((e) =>
      e.observation?.type === "data-subagent" && e.observation.data.status === "cancelled"
        ? [e.observation.data]
        : [],
    );
    assert.equal(
      cancelledChildren.length,
      2,
      "both terminal child states must be persisted before finishing the parent",
    );
    assert.equal(new Set(cancelledChildren.map((s) => s.id)).size, 2);
    assert.equal(cancelledChildren.filter((s) => s.startedAt !== null).length, 1);
    assert.equal(
      (await sdk.listMessages({ client, path: { ...path, id: slowChildren.conversationId } })).data
        ?.length,
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
