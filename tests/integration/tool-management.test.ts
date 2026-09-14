import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { type TestContext, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { ToolInput } from "../../packages/contracts/src/index.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";

/**
 * A deterministic read-only business endpoint. It is never a production service
 * and never evaluates an AI result: it answers so the probe path can be checked.
 */
async function startToolFixture() {
  const seen: { url: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: String(req.url), authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer fixture-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "凭据无效" } }));
      return;
    }
    if (req.url?.startsWith("/orders")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ order: { id: "A-1", total: 120 } }));
      return;
    }
    // A service that answers 200 with something the declared output schema
    // cannot accept. This is the one failure an operator fixes by editing the schema.
    if (req.url?.startsWith("/shifting")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(["not-an-object"]));
      return;
    }
    if (req.url?.startsWith("/plain-text")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function fixture(t: TestContext) {
  const schema = `test_tools_${randomUUID().replaceAll("-", "")}`,
    admin = new Database(required("DATABASE_URL")),
    db = new Database(required("DATABASE_URL"), schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const tools = await startToolFixture();
  t.after(async () => {
    await tools.close();
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  const platform = new Platform(db, new Vault("be".repeat(32)));
  await platform.initialize();
  const { app } = createApp(platform, {
    origin: "http://console.invalid",
    runtimeToken: "test",
    logger: () => {},
  });
  const client = createClient({
    baseUrl: "http://console.invalid",
    fetch: async (r, init) => app.request(r, init),
    throwOnError: true,
  });
  const setup = await sdk.setupPlatform({
    client,
    body: { username: "owner", password: "test-password-123", workspaceName: "Tools" },
  });
  const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  client.setConfig({ headers: { cookie } });
  const actor = await platform.identity.session(cookie.split("=")[1]);
  const project = await platform.projects.create(actor, {
    name: "Tool fixtures",
    description: "",
  });
  return { db, platform, client, actor, project, path: { projectId: project.id }, tools };
}

test("probing an http tool reproduces the Runtime call and separates a schema mismatch from a refusal", async (t) => {
  const { platform, client, actor, project, path, tools } = await fixture(t);
  const tool = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "order_lookup",
      kind: "http_get",
      description: "读取订单",
      url: `${tools.url}/orders`,
      bearerToken: "fixture-token",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { order: { type: "object" } },
        required: ["order"],
        additionalProperties: false,
      },
    }),
  );
  // The successful path: the sample is encoded the way the Runtime encodes it,
  // and the stored credential is reused rather than resupplied.
  const probed = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/orders`,
      credentialFrom: tool.id,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      input: { id: "A-1" },
    },
  });
  assert.equal(probed.data?.outcome, "ok");
  assert.equal(probed.data?.httpStatus, 200);
  assert.equal(probed.data?.latencyMs !== null, true);
  assert.ok(probed.data?.requestUrl?.endsWith("/orders?id=A-1"), probed.data?.requestUrl ?? "");
  assert.match(probed.data?.preview ?? "", /A-1/);
  assert.equal(tools.seen.at(-1)?.authorization, "Bearer fixture-token");
  assert.equal("bearerToken" in (probed.data ?? {}), false, "the stored token is never echoed");

  // A 200 whose body the declared output schema rejects is a schema problem, and
  // it is reported as such rather than as a service failure.
  const mismatch = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/shifting`,
      credentialFrom: tool.id,
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { order: { type: "object" } },
        required: ["order"],
      },
      input: {},
    },
  });
  assert.equal(mismatch.data?.outcome, "mismatch");
  assert.equal(mismatch.data?.httpStatus, 200);

  // A 200 that is not JSON is a refusal to speak the protocol, not a schema error.
  const notJson = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/plain-text`,
      credentialFrom: tool.id,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
    },
  });
  assert.equal(notJson.data?.outcome, "rejected");

  // Wrong sample arguments are the operator's own error and nothing is sent.
  const before = tools.seen.length;
  const invalid = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/orders`,
      credentialFrom: tool.id,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      input: {},
    },
  });
  assert.equal(invalid.data?.outcome, "invalid");
  assert.equal(tools.seen.length, before, "an invalid sample never reaches the service");
  assert.equal(invalid.data?.requestUrl, null);

  // A wrong token is a refusal, and the provider's own words are reported.
  const rejected = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/orders`,
      bearerToken: "wrong",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
    },
  });
  assert.equal(rejected.data?.outcome, "rejected");
  assert.equal(rejected.data?.httpStatus, 401);
  assert.match(rejected.data?.message ?? "", /凭据无效/);

  // An address the platform cannot reach is reported as the platform's network,
  // never as a verdict on the tool.
  const unreachable = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: "http://127.0.0.1:1/orders",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
    },
  });
  assert.equal(unreachable.data?.outcome, "unreachable");
  assert.equal(unreachable.data?.httpStatus, null);
});

test("probing the built-in sum tool evaluates locally and sends no request", async (t) => {
  const { platform, client, actor, project, path, tools } = await fixture(t);
  const tool = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "sum_values",
      kind: "sum",
      description: "求和",
      inputSchema: {},
      outputSchema: {},
    }),
  );
  const before = tools.seen.length;
  const probed = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "sum",
      credentialFrom: tool.id,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      input: { values: [40, 80] },
    },
  });
  assert.equal(probed.data?.outcome, "ok");
  assert.match(probed.data?.message ?? "", /120/);
  assert.equal(probed.data?.requestUrl, null);
  assert.equal(probed.data?.httpStatus, null);
  assert.equal(tools.seen.length, before, "sum never leaves the platform");
});

test("editing a tool replaces its stored configuration and keeps a blank token", async (t) => {
  const { platform, client, actor, project, path, tools } = await fixture(t);
  const tool = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "order_lookup",
      kind: "http_get",
      description: "读取订单",
      url: `${tools.url}/orders`,
      bearerToken: "fixture-token",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    }),
  );
  const updated = await sdk.updateTool({
    client,
    path: { ...path, id: tool.id },
    body: {
      name: "order_lookup",
      kind: "http_get",
      description: "读取订单与明细",
      url: `${tools.url}/orders`,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      outputSchema: { type: "object" },
    },
  });
  assert.equal(updated.data?.description, "读取订单与明细");
  assert.equal(updated.data?.hasCredential, true, "a blank token keeps the stored credential");
  // The kept credential is the real one, proven by a call that needs it.
  const probed = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "http_get",
      url: `${tools.url}/orders`,
      credentialFrom: tool.id,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
    },
  });
  assert.equal(probed.data?.outcome, "ok");

  // An update goes through the same validation as a create, so a stored tool
  // cannot be made unrunnable by editing it.
  const broken = await sdk.updateTool({
    client,
    path: { ...path, id: tool.id },
    body: {
      name: "order_lookup",
      kind: "http_get",
      description: "坏 schema",
      url: `${tools.url}/orders`,
      inputSchema: { type: "object", properties: { id: { type: "not-a-type" } } },
      outputSchema: { type: "object" },
    },
    throwOnError: false,
  });
  assert.equal(broken.response?.status, 400);
  assert.equal(broken.error?.code, "INVALID_TOOL_SCHEMA");
  assert.equal(
    (await sdk.listTools({ client, path })).data?.find((x) => x.id === tool.id)?.description,
    "读取订单与明细",
    "a rejected edit leaves the stored tool untouched",
  );
});

test("an imported MCP tool cannot be edited and cannot be probed by kind", async (t) => {
  const { db, platform, client, actor, project, path } = await fixture(t);
  const serverId = randomUUID(),
    discoveryId = randomUUID();
  await db.query(
    "INSERT INTO mcp_servers(id,tenant_id,project_id,name,url) VALUES($1,$2,$3,'MCP','http://mcp.invalid')",
    [serverId, actor.tenantId, project.id],
  );
  await db.query(
    "INSERT INTO mcp_discoveries(id,server_id,runtime_id,status,deadline) VALUES($1,$2,$3,'succeeded',now())",
    [discoveryId, serverId, platform.runtimeId],
  );
  const created = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "mcp_fixture",
      kind: "sum",
      description: "MCP fixture",
      inputSchema: {},
      outputSchema: {},
    }),
  );
  await db.query("UPDATE resources SET data=$1 WHERE id=$2", [
    {
      ...created,
      kind: "mcp",
      mcp: {
        serverId,
        contractDigest: "pinned-contract",
        descriptor: {
          name: "remote_sum",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      },
    },
    created.id,
  ]);
  const rejected = await sdk.updateTool({
    client,
    path: { ...path, id: created.id },
    body: {
      name: "mcp_fixture",
      kind: "sum",
      description: "试图编辑",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    throwOnError: false,
  });
  assert.equal(rejected.response?.status, 409);
  assert.equal(rejected.error?.code, "MCP_TOOL_IMMUTABLE");
  // The authored kinds are the only ones the probe accepts, so an imported MCP
  // tool cannot be probed through a shape it never had.
  const probed = await sdk.probeTool({
    client,
    path,
    body: {
      kind: "mcp" as never,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      input: {},
    },
    throwOnError: false,
  });
  assert.equal(probed.response?.status, 400);
});
