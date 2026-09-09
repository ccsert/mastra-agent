import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, sep } from "node:path";
import { Database } from "@platform/database";
import { createClient } from "../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { startModelFixture } from "../tests/model-fixture.ts";
import { required } from "./env.ts";

const bundle = resolve(process.argv[2] ?? "missing-bundle-directory");
async function inspect(path: string, root: string): Promise<void> {
  for (const name of await readdir(path)) {
    const file = resolve(path, name),
      stat = await lstat(file);
    if (stat.isSymbolicLink())
      assert.ok((await realpath(file)).startsWith(root + sep), `external symlink: ${file}`);
    else if (stat.isDirectory()) await inspect(file, root);
    assert.ok(!/^\.env(?:\.|$)/.test(name), "environment files must not be bundled");
  }
}
for (const service of ["control-plane", "runtime"]) {
  const root = await realpath(resolve(bundle, service));
  await inspect(root, root);
  await assert.rejects(lstat(resolve(root, "src")), { code: "ENOENT" });
  await assert.rejects(lstat(resolve(root, "node_modules/tsx")), { code: "ENOENT" });
}
await assert.rejects(lstat(resolve(bundle, "runtime/node_modules/@platform/database")), {
  code: "ENOENT",
});
await assert.rejects(lstat(resolve(bundle, "runtime/node_modules/pg")), { code: "ENOENT" });
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
const apiPort = await port(),
  runtimePort = await port(),
  baseUrl = `http://127.0.0.1:${apiPort}`;
const schema = `test_bundle_${process.pid}`,
  admin = new Database(required("DATABASE_URL"));
await admin.query(`CREATE SCHEMA ${schema}`);
const token = randomBytes(32).toString("hex"),
  key = randomBytes(32).toString("hex");
const processes: ChildProcess[] = [],
  output: string[] = [];
function start(service: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: resolve(bundle, service),
    env: { PATH: process.env.PATH, NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => output.push(chunk.toString()));
  processes.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const [code] = await exit;
  clearTimeout(timer);
  assert.equal(code, 0, "service must drain and exit normally");
}
async function until(check: () => Promise<boolean>, label: string) {
  for (let n = 0; n < 160; n++) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function control() {
  return start("control-plane", {
    DATABASE_URL: required("DATABASE_URL"),
    DATABASE_SCHEMA: schema,
    ENCRYPTION_KEY: key,
    RUNTIME_TOKEN: token,
    CONSOLE_ORIGIN: baseUrl,
    API_PORT: String(apiPort),
  });
}
const fixture = await startModelFixture();
try {
  let cp = control();
  await until(async () => (await fetch(`${baseUrl}/ready`)).ok, "compiled control plane ready");
  const runtime = start("runtime", {
    CONTROL_PLANE_URL: baseUrl,
    RUNTIME_TOKEN: token,
    RUNTIME_PORT: String(runtimePort),
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${runtimePort}/ready`)).ok,
    "compiled runtime connected",
  );
  const client = createClient({ baseUrl, throwOnError: true });
  const setup = await sdk.setupPlatform({
    client,
    body: {
      username: "bundle-owner",
      password: randomBytes(24).toString("hex"),
      workspaceName: "Isolated bundle acceptance",
    },
  });
  const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  client.setConfig({ headers: { cookie } });
  const project = (
    await sdk.createProject({
      client,
      body: { name: "Compiled services", description: "Synthetic acceptance only" },
    })
  ).data;
  assert.ok(project);
  const path = { projectId: project.id };
  const model = (
    await sdk.createModel({
      client,
      path,
      body: {
        name: "Protocol fixture",
        baseUrl: `${fixture.url}/v1`,
        modelId: "protocol-fixture",
        apiKey: "fixture-key",
      },
    })
  ).data;
  assert.ok(model);
  const tool = (
    await sdk.createTool({
      client,
      path,
      body: {
        name: "sum_values",
        description: "Synthetic sum",
        kind: "sum",
        inputSchema: {},
        outputSchema: {},
      },
    })
  ).data;
  assert.ok(tool);
  const agent = (
    await sdk.createAgent({
      client,
      path,
      body: {
        name: "Bundle agent",
        instructions: "Calculate sum",
        modelId: model.id,
        toolIds: [tool.id],
      },
    })
  ).data;
  assert.ok(agent);
  await sdk.publishAgent({ client, path: { ...path, id: agent.id }, body: { baseRevision: 1 } });
  const conversation = (
    await sdk.createConversation({
      client,
      path,
      body: { agentId: agent.id, title: "Compiled tool execution" },
    })
  ).data;
  assert.ok(conversation);
  const run = (
    await sdk.createRun({
      client,
      path,
      body: { conversationId: conversation.id, input: "40+80", requestId: randomUUID() },
    })
  ).data;
  assert.ok(run);
  await until(
    async () =>
      (await sdk.getRun({ client, path: { ...path, id: run.id } })).data?.status === "succeeded",
    "Mastra tool execution",
  );
  assert.ok(
    (await sdk.getRun({ client, path: { ...path, id: run.id } })).data?.outputText?.includes("120"),
  );
  const workflow = (
    await sdk.createWorkflow({
      client,
      path,
      body: {
        name: "Compiled workflow",
        description: "",
        definition: {
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object", properties: {}, additionalProperties: false },
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "end", type: "end", label: "End", values: {} },
          ],
          edges: [{ source: "start", target: "end", port: "out" }],
        },
      },
    })
  ).data;
  assert.ok(workflow);
  const release = (
    await sdk.publishWorkflow({
      client,
      path: { ...path, id: workflow.id },
      body: { baseRevision: 1 },
    })
  ).data;
  assert.ok(release);
  const workflowRun = (
    await sdk.createWorkflowRun({
      client,
      path: { ...path, id: workflow.id },
      body: { releaseId: release.id, input: {}, requestId: randomUUID() },
    })
  ).data;
  assert.ok(workflowRun);
  await until(
    async () =>
      (await sdk.getWorkflowRun({ client, path: { ...path, id: workflowRun.id } })).data?.status ===
      "succeeded",
    "Mastra workflow execution",
  );
  await stop(cp);
  await until(
    async () => (await fetch(`http://127.0.0.1:${runtimePort}/ready`)).status === 503,
    "disconnected readiness",
  );
  assert.equal((await fetch(`http://127.0.0.1:${runtimePort}/health`)).status, 200);
  cp = control();
  await until(
    async () => (await fetch(`http://127.0.0.1:${runtimePort}/ready`)).ok,
    "runtime reconnect",
  );
  assert.equal(
    (await sdk.getRun({ client, path: { ...path, id: run.id } })).data?.status,
    "succeeded",
  );
  assert.equal(
    (await sdk.listMessages({ client, path: { ...path, id: conversation.id } })).data?.length,
    2,
  );
  await stop(runtime);
  await stop(cp);
  assert.ok(!output.join("").includes(token) && !output.join("").includes(key));
  console.log(
    JSON.stringify({
      result: "passed",
      bundle,
      checks: [
        "isolated dependencies",
        "SQL migrations",
        "generated SDK",
        "Mastra tool call = 120",
        "Mastra workflow",
        "readiness disconnect/reconnect",
        "history after restart",
        "graceful shutdown",
      ],
      model: "deterministic protocol fixture",
    }),
  );
} finally {
  for (const child of processes)
    if (child.exitCode === null && child.signalCode === null) await stop(child);
  await fixture.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
}
