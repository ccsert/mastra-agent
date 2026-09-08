import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../apps/control-plane/src/app.ts";
import { Vault } from "../apps/control-plane/src/crypto.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { embed } from "../apps/runtime/src/knowledge.ts";
import { runWorker } from "../apps/runtime/src/worker.ts";
import { Model } from "../packages/contracts/src/index.ts";
import { createClient } from "../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { required } from "../scripts/env.ts";

async function modelFixture() {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    requests.push({ path: req.url ?? "", body: input });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.url === "/v1/embeddings") {
      const docs = input.input as string[];
      let data = docs
        .map((s, index) => ({
          index,
          embedding: s.includes("24GB") || s.includes("A5000") ? [1, 0, 0] : [0, 1, 0],
        }))
        .reverse();
      if (input.model === "wrong-dimensions") data = data.map((d) => ({ ...d, embedding: [1, 0] }));
      if (input.model === "duplicate-indices") data = data.map((d) => ({ ...d, index: 0 }));
      res.end(JSON.stringify({ data }));
      return;
    }
    if (req.url === "/v1/rerank") {
      const docs = input.documents as string[];
      const results = docs
        .map((s, index) => ({ index, relevance_score: s.includes("24GB") ? 0.99 : 0.01 }))
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, input.top_n);
      res.end(JSON.stringify({ results }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
}

test("generated SDK → HTTP knowledge worker → Mastra chunks, embedding dimensions and rerank", {
  timeout: 30000,
}, async () => {
  const schema = `test_knowledge_http_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    store = new Store(db, new Vault("ef".repeat(32)));
  await store.initialize();
  const { app } = createApp(store, {
    origin: "http://console.invalid",
    runtimeToken: "knowledge-runtime-token",
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`,
    fixture = await modelFixture(),
    controller = new AbortController();
  const worker = runWorker({
    controlPlaneUrl: baseUrl,
    runtimeId: "hosted-local",
    runtimeToken: "knowledge-runtime-token",
    signal: controller.signal,
  });
  try {
    const client = createClient({ baseUrl, throwOnError: true });
    const auth = await sdk.setupPlatform({
      client,
      body: { username: "owner", password: "test-password-123", workspaceName: "Knowledge" },
    });
    const cookie = auth.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    const project = (await sdk.createProject({ client, body: { name: "Knowledge" } })).data;
    assert.ok(project);
    const path = { projectId: project.id };
    const embedding = (
      await sdk.createModel({
        client,
        path,
        body: {
          name: "Embedding",
          kind: "embedding",
          dimensions: 3,
          baseUrl: fixture.url,
          modelId: "embedding",
          apiKey: "fixture-key",
        },
      })
    ).data;
    assert.ok(embedding);
    const rerank = (
      await sdk.createModel({
        client,
        path,
        body: {
          name: "Rerank",
          kind: "rerank",
          baseUrl: fixture.url,
          modelId: "rerank",
          apiKey: "fixture-key",
        },
      })
    ).data;
    assert.ok(rerank);
    const kb = (
      await sdk.createKnowledgeBase({
        client,
        path,
        body: {
          name: "Manual",
          embeddingModelId: embedding.id,
          rerankModelId: rerank.id,
          chunkSize: 200,
          chunkOverlap: 20,
        },
      })
    ).data;
    assert.ok(kb);
    const kbPath = { ...path, kbId: kb.id };
    const content = [
      "设备 A5000 配备 24GB 显存。",
      ...Array.from(
        { length: 25 },
        (_, i) => `业务规则 ${i}：${"文档入库后可以被团队查询。".repeat(16)}`,
      ),
    ].join("\n\n");
    const doc = (
      await sdk.uploadKnowledgeDocument({
        client,
        path: kbPath,
        body: { filename: "合成资料.md", content },
      })
    ).data;
    assert.ok(doc);
    let current: sdk.KnowledgeDocument | undefined;
    for (let i = 0; i < 100; i++) {
      current = (await sdk.listKnowledgeDocuments({ client, path: kbPath })).data?.[0];
      if (current?.status === "ready" || current?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(current?.status, "ready");
    assert.ok(current.chunkCount > 8);
    const chunks = (await sdk.listKnowledgeChunks({ client, path: { ...kbPath, id: doc.id } }))
      .data;
    assert.ok(chunks);
    assert.equal(chunks.length, current.chunkCount);
    assert.deepEqual(
      chunks.map((c) => c.ordinal),
      Array.from({ length: chunks.length }, (_, i) => i),
    );
    const search = (
      await sdk.searchKnowledge({ client, path: kbPath, body: { query: "A5000 显存", topK: 3 } })
    ).data;
    assert.ok(search);
    let result: sdk.KnowledgeSearch | undefined;
    for (let i = 0; i < 100; i++) {
      result = (await sdk.getKnowledgeSearch({ client, path: { ...kbPath, id: search.id } })).data;
      if (result?.status === "succeeded" || result?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(result?.status, "succeeded");
    assert.match(result.results[0].content, /24GB/);
    assert.equal(result.results[0].rerankScore, 0.99);
    assert.ok(
      fixture.requests
        .filter((r) => r.path.endsWith("/embeddings"))
        .every((r) => r.body.dimensions === 3),
    );
    assert.ok(fixture.requests.some((r) => r.path.endsWith("/rerank")));
    // Public DTOs and release configuration never contain model credentials.
    assert.ok(!JSON.stringify({ embedding, rerank, kb, doc, result }).includes("fixture-key"));
    const badModel = Model.parse({ ...embedding, modelId: "duplicate-indices" });
    await assert.rejects(
      () =>
        embed(
          badModel,
          { [badModel.id]: "fixture-key" },
          ["one", "two"],
          AbortSignal.timeout(2000),
        ),
      /INVALID_MODEL_RESPONSE/,
    );
    await assert.rejects(
      () =>
        embed(
          Model.parse({ ...embedding, modelId: "wrong-dimensions" }),
          { [embedding.id]: "fixture-key" },
          ["one"],
          AbortSignal.timeout(2000),
        ),
      /DIMENSION_MISMATCH/,
    );
    await sdk.deleteKnowledgeDocument({ client, path: { ...kbPath, id: doc.id }, body: {} });
    assert.equal((await sdk.listKnowledgeDocuments({ client, path: kbPath })).data?.length, 0);
  } finally {
    controller.abort();
    await worker;
    await fixture.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
