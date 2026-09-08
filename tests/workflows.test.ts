import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../apps/control-plane/src/app.ts";
import { Vault } from "../apps/control-plane/src/crypto.ts";
import { Platform } from "../apps/control-plane/src/platform.ts";
import { runWorker } from "../apps/runtime/src/worker.ts";
import { WorkflowAssetInput, WorkflowDefinition } from "../packages/contracts/src/index.ts";
import { applicationSigner } from "../packages/sdk/src/auth.ts";
import { createClient } from "../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { required } from "../scripts/env.ts";
import { mcpFixture } from "./mcp-fixture.ts";
import { startModelFixture } from "./model-fixture.ts";

const defined = <T>(value: T | undefined): T => {
  assert.notEqual(value, undefined);
  return value as T;
};
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 180; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 75));
  }
  throw new Error("Workflow timed out");
}
test("SDK → durable workflow → MCP + published Agent → Mastra branch; AI revisions, scopes and leases", {
  timeout: 50000,
}, async () => {
  const schema = `test_workflow_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    store = new Platform(db, new Vault("f3".repeat(32)));
  await store.initialize();
  const { app, workflowQueue } = createApp(store, {
    origin: "http://console.invalid",
    runtimeToken: "workflow-runtime",
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener failed");
  const baseUrl = `http://127.0.0.1:${address.port}`,
    mcp = await mcpFixture(),
    generationArguments: Record<string, unknown> = {};
  let firstSubmission: Record<string, unknown> | undefined;
  const model = await startModelFixture(0, {
    toolArguments: () => {
      const next = firstSubmission;
      firstSubmission = undefined;
      return next ?? generationArguments;
    },
    answer: "合成采购报告：RTX A5000 24GB。",
  });
  const stop = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const client = createClient({ baseUrl, throwOnError: true });
    const setup = await sdk.setupPlatform({
      client,
      body: { username: "owner", password: "test-password-123", workspaceName: "Workflow" },
    });
    const actor = defined(setup.data),
      cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    const project = defined((await sdk.createProject({ client, body: { name: "Workflow" } })).data),
      path = { projectId: project.id };
    const other = defined((await sdk.createProject({ client, body: { name: "Other" } })).data);
    const registeredModel = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "Fixture",
            baseUrl: `${model.url}/v1`,
            modelId: "protocol-fixture",
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
            name: "报告助手",
            modelId: registeredModel.id,
            instructions: "生成采购报告",
            toolIds: [],
          },
        })
      ).data,
    );
    const agentRelease = defined(
      (
        await sdk.publishAgent({
          client,
          path: { ...path, id: agent.id },
          body: { baseRevision: 1 },
        })
      ).data,
    );
    const service = defined(
      (
        await sdk.createMcpServer({
          client,
          path,
          body: { name: "Orders", url: mcp.url, bearerToken: "mcp-fixture-key" },
        })
      ).data,
    );
    const discovery = defined(
      (await sdk.discoverMcpTools({ client, path: { ...path, id: service.id }, body: {} })).data,
    );
    worker = runWorker({
      controlPlaneUrl: baseUrl,
      runtimeToken: "workflow-runtime",
      runtimeId: store.runtimeId,
      signal: stop.signal,
    });
    await until(
      async () =>
        defined(
          (await sdk.listMcpDiscoveries({ client, path: { ...path, id: service.id } })).data,
        )[0],
      (d) => d.status === "succeeded",
    );
    const tool = defined(
      (
        await sdk.importMcpTool({
          client,
          path: { ...path, id: service.id },
          body: {
            discoveryId: discovery.id,
            remoteName: "orders_lookup",
            name: "lookup_order",
            confirmedReadOnly: true,
          },
        })
      ).data,
    );
    const definition = WorkflowDefinition.parse({
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string", minLength: 1, maxLength: 40 } },
        required: ["orderId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { report: { type: "string" } },
        required: ["report"],
        additionalProperties: false,
      },
      nodes: [
        { id: "start", type: "start", label: "输入订单号" },
        {
          id: "lookup",
          type: "tool",
          label: "查询订单",
          toolId: tool.id,
          input: { orderId: { kind: "ref", path: "input.orderId" } },
        },
        {
          id: "check",
          type: "condition",
          label: "订单是否存在",
          left: { kind: "ref", path: "nodes.lookup.data.status" },
          operator: "neq",
          right: { kind: "literal", value: "不存在" },
        },
        {
          id: "report",
          type: "agent",
          label: "生成报告",
          releaseId: agentRelease.id,
          prompt: { kind: "template", template: `为订单生成报告：\${nodes.lookup.data}` },
        },
        {
          id: "end",
          type: "end",
          label: "输出报告",
          values: { report: { kind: "ref", path: "nodes.report.text" } },
        },
        {
          id: "missing",
          type: "end",
          label: "订单不存在",
          values: { report: { kind: "literal", value: "订单不存在" } },
        },
      ],
      edges: [
        { source: "start", target: "lookup", port: "out" },
        { source: "lookup", target: "check", port: "out" },
        { source: "check", target: "report", port: "true" },
        { source: "check", target: "missing", port: "false" },
        { source: "report", target: "end", port: "out" },
      ],
    });
    const draft = WorkflowAssetInput.parse({
      name: "采购报告",
      definition,
      layout: { start: { x: 13, y: 29 }, lookup: { x: 303, y: 29 } },
    });
    let asset = defined((await sdk.createWorkflow({ client, path, body: draft })).data);
    const assetPath = { ...path, id: asset.id };
    assert.deepEqual(
      (await sdk.validateWorkflow({ client, path: assetPath, body: { baseRevision: 1 } })).data
        ?.issues,
      [],
    );
    const release = defined(
      (await sdk.publishWorkflow({ client, path: assetPath, body: { baseRevision: 1 } })).data,
    );
    assert.ok(!JSON.stringify(release).includes("fixture-key"));
    assert.equal(release.snapshot.agents[0].id, agentRelease.id);
    assert.equal(
      (
        await sdk.getWorkflow({
          client,
          path: { projectId: other.id, id: asset.id },
          throwOnError: false,
        })
      ).response?.status,
      404,
    );
    assert.equal(
      (
        await sdk.updateWorkflow({
          client,
          path: assetPath,
          body: { ...draft, baseRevision: 99 },
          throwOnError: false,
        })
      ).response?.status,
      409,
    );
    const credential = defined(
      (await sdk.createApplication({ client, path, body: { name: "Business" } })).data,
    );
    const appClient = createClient({ baseUrl, throwOnError: true });
    appClient.interceptors.request.use(
      applicationSigner({
        appId: credential.id,
        accessKey: credential.accessKey,
        secretKey: credential.secretKey,
      }),
    );
    assert.equal(
      (await sdk.getWorkflowCatalog({ client: appClient, path, throwOnError: false })).response
        ?.status,
      403,
    );
    for (const orderId of ["ORD-1001", "MISSING"]) {
      const request = { releaseId: release.id, input: { orderId }, requestId: randomUUID() };
      const started = defined(
        (await sdk.createWorkflowRun({ client: appClient, path: assetPath, body: request })).data,
      );
      assert.equal(
        (await sdk.createWorkflowRun({ client: appClient, path: assetPath, body: request })).data
          ?.id,
        started.id,
      );
      const runPath = { ...path, id: started.id };
      const result = await until(
        async () => defined((await sdk.getWorkflowRun({ client: appClient, path: runPath })).data),
        (r) => !["queued", "running"].includes(r.status),
      );
      assert.equal(
        result.status,
        "succeeded",
        JSON.stringify({
          result,
          nodes: (await sdk.listWorkflowNodeRuns({ client: appClient, path: runPath })).data,
        }),
      );
      assert.equal(
        result.output?.report,
        orderId === "ORD-1001" ? "合成采购报告：RTX A5000 24GB。" : "订单不存在",
      );
      const nodes = defined(
        (await sdk.listWorkflowNodeRuns({ client: appClient, path: runPath })).data,
      );
      assert.equal(
        nodes.find((n) => n.nodeId === "report")?.status,
        orderId === "ORD-1001" ? "succeeded" : "skipped",
      );
      assert.equal(
        nodes.find((n) => n.nodeId === "missing")?.status,
        orderId === "ORD-1001" ? "skipped" : "succeeded",
      );
      assert.equal(
        (await sdk.getWorkflowRun({ client, path: runPath, throwOnError: false })).response?.status,
        404,
      );
    }
    assert.equal(mcp.calls.length, 2);
    Object.assign(generationArguments, {
      definition: structuredClone(definition),
      explanation: "增加不存在时的提示",
    });
    const candidateDefinition = generationArguments.definition as WorkflowDefinition;
    const missing = candidateDefinition.nodes.find((n) => n.id === "missing");
    if (missing?.type !== "end") throw new Error("Fixture invalid");
    missing.values.report = { kind: "literal", value: "未找到该订单，请核对编号" };
    const beginGeneration = async (baseRevision: number) => {
      const started = defined(
        (
          await sdk.generateWorkflow({
            client,
            path: assetPath,
            body: {
              baseRevision,
              modelId: registeredModel.id,
              intent: "修改缺失订单提示",
              requestId: randomUUID(),
            },
          })
        ).data,
      );
      return until(
        async () =>
          defined(
            (await sdk.getWorkflowGeneration({ client, path: { ...path, id: started.id } })).data,
          ),
        (g) => !["queued", "running"].includes(g.status),
      );
    };
    firstSubmission = { definition: structuredClone(draft.definition), explanation: "原样返回" };
    const stale = await beginGeneration(1);
    assert.equal(stale.attempts, 2);
    assert.equal(stale.status, "succeeded", JSON.stringify(stale));
    asset = defined(
      (
        await sdk.updateWorkflow({
          client,
          path: assetPath,
          body: { ...draft, name: "人工改名", baseRevision: 1 },
        })
      ).data,
    );
    assert.equal(
      (
        await sdk.acceptWorkflowGeneration({
          client,
          path: { ...path, id: stale.id },
          body: { baseRevision: 1 },
          throwOnError: false,
        })
      ).response?.status,
      409,
    );
    assert.equal((await sdk.getWorkflow({ client, path: assetPath })).data?.name, "人工改名");
    assert.deepEqual(asset.layout, draft.layout, "manual updates retain the saved geometry");
    const candidate = await beginGeneration(asset.revision);
    assert.equal(candidate.status, "succeeded", JSON.stringify(candidate));
    asset = defined(
      (
        await sdk.acceptWorkflowGeneration({
          client,
          path: { ...path, id: candidate.id },
          body: { baseRevision: asset.revision },
        })
      ).data,
    );
    assert.equal(asset.revision, 3);
    assert.deepEqual(asset.layout, {}, "AI graph replacement must not reuse stale geometry");
    const v2 = defined(
      (
        await sdk.publishWorkflow({
          client,
          path: assetPath,
          body: { baseRevision: asset.revision },
        })
      ).data,
    );
    assert.equal(v2.version, 2);
    assert.notEqual(v2.digest, release.digest);
    for (const version of [release, v2]) {
      const run = defined(
        (
          await sdk.createWorkflowRun({
            client,
            path: assetPath,
            body: { releaseId: version.id, input: { orderId: "MISSING" }, requestId: randomUUID() },
          })
        ).data,
      );
      const result = await until(
        async () =>
          defined((await sdk.getWorkflowRun({ client, path: { ...path, id: run.id } })).data),
        (r) => !["queued", "running"].includes(r.status),
      );
      assert.equal(
        result.output?.report,
        version.version === 1 ? "订单不存在" : "未找到该订单，请核对编号",
      );
    }
    stop.abort();
    await worker;
    worker = undefined;
    const queued = defined(
      (
        await sdk.createWorkflowRun({
          client,
          path: assetPath,
          body: { releaseId: v2.id, input: { orderId: "ORD-1001" }, requestId: randomUUID() },
        })
      ).data,
    );
    const job = await workflowQueue.claim();
    assert.ok(job);
    assert.equal(job.id, queued.id);
    await assert.rejects(() => workflowQueue.startNode(job.id, "report", job.leaseToken), /路径/);
    await workflowQueue.startNode(job.id, "start", job.leaseToken);
    await workflowQueue.finishNode(job.id, "start", {
      leaseToken: job.leaseToken,
      status: "succeeded",
      output: { orderId: "ORD-1001" },
    });
    await workflowQueue.startNode(job.id, "lookup", job.leaseToken);
    const binding = await workflowQueue.authorizeMcp(job.id, "lookup", job.leaseToken, tool.id);
    assert.equal(binding.bearerToken, "mcp-fixture-key");
    await sdk.updateMcpServer({
      client,
      path: { ...path, id: service.id },
      body: { enabled: false },
    });
    await assert.rejects(
      () => workflowQueue.authorizeMcp(job.id, "lookup", job.leaseToken, tool.id),
      /停用/,
    );
    await sdk.cancelWorkflowRun({ client, path: { ...path, id: job.id }, body: {} });
    await assert.rejects(
      () =>
        workflowQueue.finishNode(job.id, "lookup", {
          leaseToken: job.leaseToken,
          status: "succeeded",
          output: {},
        }),
      /租约/,
    );
    assert.equal(
      (await sdk.listWorkflowNodeRuns({ client, path: { ...path, id: job.id } })).data?.find(
        (n) => n.nodeId === "lookup",
      )?.status,
      "cancelled",
    );
    await sdk.updateMcpServer({
      client,
      path: { ...path, id: service.id },
      body: { enabled: true },
    });
    const lateRun = defined(
      (
        await sdk.createWorkflowRun({
          client,
          path: assetPath,
          body: { releaseId: v2.id, input: { orderId: "MISSING" }, requestId: randomUUID() },
        })
      ).data,
    );
    const late = await workflowQueue.claim();
    assert.ok(late);
    assert.equal(late.id, lateRun.id);
    await workflowQueue.startNode(late.id, "start", late.leaseToken);
    await db.query(
      "UPDATE workflow_jobs SET lease_until=clock_timestamp()+interval '120 milliseconds' WHERE id=$1",
      [late.id],
    );
    const lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM workflow_jobs WHERE id=$1 FOR UPDATE", [late.id]);
    const finish = workflowQueue.finishNode(late.id, "start", {
      leaseToken: late.leaseToken,
      status: "succeeded",
      output: { orderId: "MISSING" },
    });
    const rejected = assert.rejects(finish, /租约/);
    await new Promise((r) => setTimeout(r, 180));
    await lock.query("COMMIT");
    lock.release();
    await rejected;
    await workflowQueue.reap();
    assert.equal(
      (await sdk.getWorkflowRun({ client, path: { ...path, id: late.id } })).data?.status,
      "failed",
    );
    const embedding = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "Lease embedding",
            kind: "embedding",
            dimensions: 3,
            baseUrl: `${model.url}/v1`,
            modelId: "embedding",
            apiKey: "fixture-key",
          },
        })
      ).data,
    );
    const kb = defined(
      (
        await sdk.createKnowledgeBase({
          client,
          path,
          body: { name: "Lease knowledge", embeddingModelId: embedding.id },
        })
      ).data,
    );
    const knowledgeAgent = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "Knowledge lease",
            modelId: registeredModel.id,
            instructions: "Query knowledge",
            toolIds: [],
            knowledgeBaseIds: [kb.id],
          },
        })
      ).data,
    );
    const knowledgeRelease = defined(
      (
        await sdk.publishAgent({
          client,
          path: { ...path, id: knowledgeAgent.id },
          body: { baseRevision: 1 },
        })
      ).data,
    );
    const knowledgeFlow = defined(
      (
        await sdk.createWorkflow({
          client,
          path,
          body: {
            name: "Knowledge lease",
            layout: {},
            definition: {
              inputSchema: { type: "object" },
              outputSchema: {
                type: "object",
                properties: { report: { type: "string" } },
                required: ["report"],
              },
              nodes: [
                { id: "start", type: "start", label: "Start" },
                {
                  id: "report",
                  type: "agent",
                  label: "Report",
                  releaseId: knowledgeRelease.id,
                  prompt: { kind: "literal", value: "Query knowledge" },
                },
                {
                  id: "end",
                  type: "end",
                  label: "End",
                  values: { report: { kind: "ref", path: "nodes.report.text" } },
                },
              ],
              edges: [
                { source: "start", target: "report", port: "out" },
                { source: "report", target: "end", port: "out" },
              ],
            },
          },
        })
      ).data,
    );
    const knowledgeFlowRelease = defined(
      (
        await sdk.publishWorkflow({
          client,
          path: { ...path, id: knowledgeFlow.id },
          body: { baseRevision: 1 },
        })
      ).data,
    );
    await sdk.createWorkflowRun({
      client,
      path: { ...path, id: knowledgeFlow.id },
      body: { releaseId: knowledgeFlowRelease.id, input: {}, requestId: randomUUID() },
    });
    const knowledgeJob = await workflowQueue.claim();
    assert.ok(knowledgeJob);
    await workflowQueue.startNode(knowledgeJob.id, "start", knowledgeJob.leaseToken);
    await workflowQueue.finishNode(knowledgeJob.id, "start", {
      leaseToken: knowledgeJob.leaseToken,
      status: "succeeded",
      output: {},
    });
    await workflowQueue.startNode(knowledgeJob.id, "report", knowledgeJob.leaseToken);
    const chunkLock = await db.pool.connect();
    await chunkLock.query("BEGIN");
    await chunkLock.query("LOCK TABLE knowledge_chunks IN ACCESS EXCLUSIVE MODE");
    try {
      await db.query(
        "UPDATE workflow_jobs SET lease_until=clock_timestamp()+interval '120 milliseconds' WHERE id=$1",
        [knowledgeJob.id],
      );
      const query = workflowQueue.queryKnowledge(knowledgeJob.id, "report", {
        leaseToken: knowledgeJob.leaseToken,
        knowledgeBaseId: kb.id,
        vector: [1, 0, 0],
      });
      const queryRejected = assert.rejects(query, /租约/);
      await new Promise((r) => setTimeout(r, 180));
      await chunkLock.query("COMMIT");
      await queryRejected;
    } finally {
      await chunkLock.query("ROLLBACK");
      chunkLock.release();
    }
    await workflowQueue.reap();
    assert.ok(actor.id);
  } finally {
    stop.abort();
    await worker;
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await model.close();
    await mcp.close();
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
