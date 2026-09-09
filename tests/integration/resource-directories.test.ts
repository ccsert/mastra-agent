import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import {
  AgentInput,
  ModelInput,
  ToolInput,
  WorkflowAssetInput,
} from "../../packages/contracts/src/index.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";
import { standardSkill } from "../fixtures/skill-fixture.ts";

async function fixture(t: TestContext) {
  const schema = `test_directories_${randomUUID().replaceAll("-", "")}`,
    admin = new Database(required("DATABASE_URL")),
    db = new Database(required("DATABASE_URL"), schema);
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  const platform = new Platform(db, new Vault("af".repeat(32)));
  await platform.initialize();
  const { app, workflows, knowledge } = createApp(platform, {
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
    body: { username: "owner", password: "test-password-123", workspaceName: "Directories" },
  });
  const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  client.setConfig({ headers: { cookie } });
  const actor = await platform.identity.session(cookie.split("=")[1]);
  const project = await platform.projects.create(actor, {
    name: "Directory fixtures",
    description: "",
  });
  const path = { projectId: project.id };
  const model = await platform.resources.createModel(
    actor,
    project.id,
    ModelInput.parse({
      name: "Fixture",
      kind: "chat",
      modelId: "fixture",
      baseUrl: "http://model.invalid/v1",
      apiKey: "catalog-must-not-expose-this-key",
    }),
  );
  const tool = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "fixture_sum",
      kind: "sum",
      description: "Synthetic sum",
      inputSchema: {},
      outputSchema: {},
    }),
  );
  const input = AgentInput.parse({
    name: "Pinned name",
    modelId: model.id,
    instructions: "private-agent-instructions",
    toolIds: [tool.id],
  });
  const agent = await platform.agents.create(actor, project.id, input);
  const release = await platform.agents.publish(actor, project.id, agent.id, 1);
  return {
    db,
    platform,
    workflows,
    knowledge,
    client,
    actor,
    project,
    path,
    model,
    tool,
    input,
    agent,
    release,
  };
}

test("complete workflow catalogs have a fixed query count and preserve old published capabilities for AI", async (t) => {
  const {
    db,
    platform,
    workflows,
    client,
    actor,
    project,
    path,
    model,
    tool,
    input,
    agent,
    release,
  } = await fixture(t);
  const queries = t.mock.method(db, "query");
  async function catalog() {
    const before = queries.mock.callCount();
    const result = await workflows.catalog(actor, project.id);
    assert.equal(
      queries.mock.callCount() - before,
      3,
      "access check and two catalog queries, independent of release/dependency count",
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /catalog-must-not-expose|private-agent-instructions|secret_enc|baseUrl/,
    );
    return result;
  }
  assert.equal((await catalog()).length, 2);
  await db.query("UPDATE resources SET created_at='2020-01-01' WHERE id=$1", [tool.id]);
  await db.query("UPDATE releases SET created_at='2020-01-01' WHERE id=$1", [release.id]);
  await db.query(
    `INSERT INTO resources(id,tenant_id,project_id,kind,data,created_at)
    SELECT gen_random_uuid(),tenant_id,project_id,kind,data,'2026-01-01'::timestamptz+n*interval '1 microsecond'
    FROM resources CROSS JOIN generate_series(1,125) n WHERE id=$1`,
    [tool.id],
  );
  await db.query(
    `INSERT INTO releases(id,tenant_id,project_id,agent_id,version,digest,snapshot,created_at)
    SELECT gen_random_uuid(),tenant_id,project_id,agent_id,n,digest,snapshot,'2026-01-01'::timestamptz+n*interval '1 microsecond'
    FROM releases CROSS JOIN generate_series(2,126) n WHERE id=$1`,
    [release.id],
  );
  await platform.agents.update(
    actor,
    project.id,
    agent.id,
    { ...input, name: "Unpublished replacement" },
    1,
  );
  const entries = await catalog();
  assert.equal(entries.length, 252);
  assert.ok(entries.some((e) => e.kind === "tool" && e.id === tool.id));
  assert.ok(
    entries.some(
      (e) =>
        e.kind === "agent" && e.id === release.id && e.version === 1 && e.name === "Pinned name",
    ),
  );
  assert.deepEqual((await sdk.getWorkflowCatalog({ client, path })).data, entries);
  await assert.rejects(workflows.catalog({ ...actor, tenantId: randomUUID() }, project.id), {
    status: 404,
  });
  await assert.rejects(
    workflows.catalog({ ...actor, kind: "application", projectId: project.id }, project.id),
    { status: 403 },
  );
  const other = await platform.projects.create(actor, { name: "Empty", description: "" });
  assert.deepEqual(await workflows.catalog(actor, other.id), []);
  const workflow = await workflows.create(
    actor,
    project.id,
    WorkflowAssetInput.parse({
      name: "AI directory fixture",
      definition: {
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "end", type: "end", label: "End", values: {} },
        ],
        edges: [{ source: "start", target: "end", port: "out" }],
      },
    }),
  );
  const generation = await workflows.generate(actor, project.id, workflow.id, {
    baseRevision: 1,
    modelId: model.id,
    intent: "Use the original release",
    requestId: "complete",
  });
  const [job] = await db.query(
    "SELECT snapshot->'catalog' AS catalog FROM workflow_jobs WHERE id=$1",
    [generation.id],
  );
  assert.deepEqual(
    job.catalog,
    entries,
    "AI receives the same complete, fixed catalog as the editor",
  );
  await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "large_schema",
      kind: "http_get",
      url: "http://tool.invalid",
      description: "Context budget fixture",
      inputSchema: { type: "object", description: "x".repeat(160001) },
      outputSchema: { type: "object" },
    }),
  );
  await assert.rejects(
    workflows.generate(actor, project.id, workflow.id, {
      baseRevision: 1,
      modelId: model.id,
      intent: "Too large",
      requestId: "overflow",
    }),
    { code: "CATALOG_LIMIT" },
  );
  const [count] = await db.query(
    "SELECT count(*)::int AS n FROM workflow_jobs WHERE workflow_id=$1",
    [workflow.id],
  );
  assert.equal(
    count.n,
    1,
    "oversized catalogs are rejected before scheduling, never silently trimmed",
  );
  const revised = await workflows.update(
    actor,
    project.id,
    workflow.id,
    {
      name: workflow.name,
      description: workflow.description,
      layout: {},
      definition: {
        ...workflow.definition,
        nodes: [
          { id: "start", type: "start", label: "Start" },
          {
            id: "agent",
            type: "agent",
            label: "Original Agent",
            releaseId: release.id,
            prompt: { kind: "literal", value: "Summarize" },
          },
          { id: "end", type: "end", label: "End", values: {} },
        ],
        edges: [
          { source: "start", target: "agent", port: "out" },
          { source: "agent", target: "end", port: "out" },
        ],
      },
    },
    1,
  );
  const scoped = await sdk.generateWorkflow({
    client,
    path: { ...path, id: workflow.id },
    body: {
      baseRevision: revised.revision,
      modelId: model.id,
      intent: "Use selected capabilities",
      requestId: "scoped",
      capabilityIds: [tool.id],
    },
  });
  assert.ok(scoped.data);
  const [selected] = await db.query(
    "SELECT snapshot->'catalog' AS catalog FROM workflow_jobs WHERE id=$1",
    [scoped.data.id],
  );
  assert.deepEqual(
    selected.catalog,
    entries.filter((entry) => [tool.id, release.id].includes(entry.id)),
    "selection excludes unrelated large resources but retains the draft's pinned Agent version",
  );
  await assert.rejects(
    workflows.generate(actor, project.id, workflow.id, {
      baseRevision: revised.revision,
      modelId: model.id,
      intent: "Invalid selection",
      requestId: "unknown",
      capabilityIds: [randomUUID()],
    }),
    { code: "DEPENDENCY_UNAVAILABLE" },
  );
});

test("catalog availability follows pinned Skill, MCP and knowledge dependencies without blocking unrelated entries", async (t) => {
  const { db, platform, workflows, knowledge, actor, project, input, tool, release } =
    await fixture(t);
  const skill = await platform.skills.upload(actor, project.id, standardSkill());
  const embedding = await platform.resources.createModel(
    actor,
    project.id,
    ModelInput.parse({
      name: "Embedding",
      kind: "embedding",
      modelId: "fixture",
      baseUrl: "http://embedding.invalid/v1",
      dimensions: 1024,
    }),
  );
  const kb = await knowledge.create(actor, project.id, {
    name: "Knowledge",
    description: "",
    embeddingModelId: embedding.id,
    rerankModelId: null,
    chunkSize: 500,
    chunkOverlap: 50,
  });
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
  const mcp = await platform.resources.createTool(
    actor,
    project.id,
    ToolInput.parse({
      name: "mcp_fixture",
      description: "MCP fixture",
      kind: "sum",
      inputSchema: {},
      outputSchema: {},
    }),
  );
  const payload = {
    ...mcp,
    kind: "mcp",
    mcp: {
      serverId,
      contractDigest: "pinned-contract",
      descriptor: {
        name: "remote_sum",
        inputSchema: mcp.inputSchema,
        outputSchema: mcp.outputSchema,
      },
    },
  };
  await db.query("UPDATE resources SET data=$1 WHERE id=$2", [payload, mcp.id]);
  await db.query(
    "INSERT INTO mcp_imports(server_id,remote_name,contract_digest,platform_name,tool_id,discovery_id,reviewed_by) VALUES($1,'remote_sum','pinned-contract','mcp_fixture',$2,$3,$4)",
    [serverId, mcp.id, discoveryId, actor.id],
  );
  const dependent = await platform.agents.create(actor, project.id, {
    ...input,
    toolIds: [mcp.id],
    knowledgeBaseIds: [kb.id],
    skillBindings: [{ versionId: skill.id, entrypoints: [] }],
  });
  const pinned = await platform.agents.publish(actor, project.id, dependent.id, 1);
  async function visible(expected: boolean, mcpVisible = true) {
    const catalog = await workflows.catalog(actor, project.id);
    assert.equal(
      catalog.some((c) => c.id === pinned.id),
      expected,
    );
    assert.equal(
      catalog.some((c) => c.id === mcp.id),
      mcpVisible,
    );
    assert.ok(catalog.some((c) => c.id === release.id));
    assert.ok(catalog.some((c) => c.id === tool.id));
  }
  await visible(true);
  await platform.skills.setEnabled(actor, project.id, skill.id, false);
  await visible(false);
  await platform.skills.setEnabled(actor, project.id, skill.id, true);
  await visible(true);
  await db.query("UPDATE mcp_servers SET enabled=false WHERE id=$1", [serverId]);
  await visible(false, false);
  await db.query("UPDATE mcp_servers SET enabled=true WHERE id=$1", [serverId]);
  await db.query("UPDATE mcp_imports SET contract_digest='different' WHERE tool_id=$1", [mcp.id]);
  await visible(false, false);
  await db.query("UPDATE mcp_imports SET contract_digest='pinned-contract' WHERE tool_id=$1", [
    mcp.id,
  ]);
  await visible(true);
  await db.query("DELETE FROM resources WHERE id=$1", [embedding.id]);
  await visible(false);
});

test("SDK pages enumerate conversation and document directories with stable scope and bounded reads", async (t) => {
  const { db, platform, knowledge, client, actor, project, path, agent, release } =
    await fixture(t);
  await db.query(
    `INSERT INTO conversations(id,tenant_id,project_id,actor_id,entry,agent_id,release_id,title,created_at)
    SELECT gen_random_uuid(),$1,$2,$3,'console',$4,$5,'Synthetic '||n,'2026-01-01'::timestamptz+(n/3)*interval '1 microsecond' FROM generate_series(1,127) n`,
    [actor.tenantId, project.id, actor.id, agent.id, release.id],
  );
  const embedding = await platform.resources.createModel(
    actor,
    project.id,
    ModelInput.parse({
      name: "Embedding",
      kind: "embedding",
      modelId: "fixture",
      baseUrl: "http://model.invalid",
      dimensions: 1024,
    }),
  );
  const kb = await knowledge.create(actor, project.id, {
    name: "Documents",
    description: "",
    embeddingModelId: embedding.id,
    rerankModelId: null,
    chunkSize: 500,
    chunkOverlap: 50,
  });
  const other = await knowledge.create(actor, project.id, {
    name: "Other",
    description: "",
    embeddingModelId: embedding.id,
    rerankModelId: null,
    chunkSize: 500,
    chunkOverlap: 50,
  });
  await db.query(
    `INSERT INTO knowledge_documents(id,knowledge_base_id,filename,content,content_hash,status,job_id,created_at)
    SELECT gen_random_uuid(),$1,'fixture-'||n||'.md','body-must-not-appear-in-directory',n::text,CASE WHEN n=128 THEN 'deleted' ELSE 'ready' END,gen_random_uuid(),'2026-01-01'::timestamptz+(n/3)*interval '1 microsecond' FROM generate_series(1,128) n`,
    [kb.id],
  );
  const queries = t.mock.method(db, "query");
  for (const kind of ["conversations", "documents"] as const) {
    const expected = (
      await db.query(
        kind === "conversations"
          ? "SELECT id FROM conversations WHERE project_id=$1 ORDER BY created_at DESC,id DESC"
          : "SELECT id FROM knowledge_documents WHERE knowledge_base_id=$1 AND status<>'deleted' ORDER BY created_at DESC,id DESC",
        [kind === "conversations" ? project.id : kb.id],
      )
    ).map((r) => String(r.id));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const before = queries.mock.callCount();
      const page =
        kind === "conversations"
          ? await platform.conversations.list(actor, project.id, { cursor, limit: 13 })
          : await knowledge.documents(actor, project.id, kb.id, { cursor, limit: 13 });
      assert.equal(queries.mock.callCount() - before, kind === "conversations" ? 2 : 3);
      const response =
        kind === "conversations"
          ? await sdk.listConversations({ client, path, query: { cursor, limit: 13 } })
          : await sdk.listKnowledgeDocuments({
              client,
              path: { ...path, kbId: kb.id },
              query: { cursor, limit: 13 },
            });
      assert.deepEqual(response.data, page.items);
      assert.equal(response.response?.headers.get("X-Next-Cursor"), page.nextCursor);
      assert.doesNotMatch(JSON.stringify(response.data), /body-must-not-appear/);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      if (seen.length === 13) {
        assert.ok(cursor);
        if (kind === "conversations") {
          await assert.rejects(
            platform.conversations.list({ ...actor, id: randomUUID() }, project.id, { cursor }),
            { code: "INVALID_CURSOR" },
          );
          await assert.rejects(
            platform.conversations.list({ ...actor, entry: "app:other" }, project.id, { cursor }),
            { code: "INVALID_CURSOR" },
          );
          await platform.conversations.create(actor, project.id, agent.id, "Newer insert");
          await db.query("DELETE FROM conversations WHERE id=$1", [seen.at(-1)]);
        } else {
          await assert.rejects(knowledge.documents(actor, project.id, other.id, { cursor }), {
            code: "INVALID_CURSOR",
          });
          await db.query("UPDATE knowledge_documents SET status='deleted' WHERE id=$1", [
            seen.at(-1),
          ]);
        }
      }
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 127);
  }
  for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "invalid" }]) {
    assert.equal(
      (await sdk.listConversations({ client, path, query, throwOnError: false })).response?.status,
      400,
    );
    assert.equal(
      (
        await sdk.listKnowledgeDocuments({
          client,
          path: { ...path, kbId: kb.id },
          query,
          throwOnError: false,
        })
      ).response?.status,
      400,
    );
  }
});
