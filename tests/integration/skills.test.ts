import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import { runWorker } from "../../apps/runtime/src/worker.ts";
import { createClient } from "../../packages/sdk/src/generated/client/index.ts";
import * as sdk from "../../packages/sdk/src/index.ts";
import { required } from "../../scripts/env.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";
import { standardSkill } from "../fixtures/skill-fixture.ts";

const defined = <T>(value: T | undefined): T => {
  assert.notEqual(value, undefined);
  return value as T;
};
test("generated SDK imports and fences immutable Skills; Mastra discovers and reads the pinned version", {
  timeout: 60000,
}, async () => {
  const schema = `test_skills_${process.pid}`,
    admin = new Database(required("DATABASE_URL"));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Database(required("DATABASE_URL"), schema),
    platform = new Platform(db, new Vault("ae".repeat(32)));
  await platform.initialize();
  const { app } = createApp(platform, {
    origin: "http://console.invalid",
    runtimeToken: "skill-test-token",
    logger: () => {},
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener");
  const baseUrl = `http://127.0.0.1:${address.port}`,
    script = !!process.env.SKILL_TEST_IMAGE;
  const model = await startModelFixture(0, {
    toolSequence: [
      { name: "skill", input: { name: "report-skill" } },
      { name: "skill_read", input: { skillName: "report-skill", path: "references/rules.md" } },
      ...(script
        ? [
            {
              name: "run_skill_script",
              input: {
                skillName: "report-skill",
                entrypoint: "scripts/report.mjs",
                input: { values: [40, 80] },
              },
            },
          ]
        : []),
    ],
    answer: "合成 Skill 验收完成。",
  });
  const stop = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const client = createClient({ baseUrl, throwOnError: true });
    const setup = await sdk.setupPlatform({
      client,
      body: { username: "skill-owner", password: "test-password-123", workspaceName: "Skills" },
    });
    const cookie = setup.response?.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    client.setConfig({ headers: { cookie } });
    const project = defined((await sdk.createProject({ client, body: { name: "Skills" } })).data),
      other = defined((await sdk.createProject({ client, body: { name: "Other" } })).data),
      path = { projectId: project.id };
    const v1 = defined(
      (await sdk.uploadSkill({ client, path, body: { archiveBase64: standardSkill() } })).data,
    );
    assert.equal(v1.version, 1);
    assert.equal(
      defined(
        (await sdk.uploadSkill({ client, path, body: { archiveBase64: standardSkill() } })).data,
      ).id,
      v1.id,
    );
    const v2 = defined(
      (await sdk.uploadSkill({ client, path, body: { archiveBase64: standardSkill("TWO") } })).data,
    );
    assert.equal(v2.version, 2);
    const first = await sdk.listSkills({ client, path, query: { limit: 1 } });
    assert.deepEqual(
      first.data?.map((s) => s.id),
      [v2.id],
    );
    const cursor = first.response?.headers.get("X-Next-Cursor");
    assert.ok(cursor);
    assert.deepEqual(
      (await sdk.listSkills({ client, path, query: { cursor, limit: 1 } })).data?.map((s) => s.id),
      [v1.id],
    );
    assert.equal(
      (
        await sdk.getSkill({
          client,
          path: { projectId: other.id, id: v1.id },
          throwOnError: false,
        })
      ).response?.status,
      404,
    );
    const registered = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "Fixture",
            baseUrl: `${model.url}/v1`,
            modelId: "fixture",
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
            name: "Skill Agent",
            instructions: "Use report-skill to sum values.",
            modelId: registered.id,
            toolIds: [],
            skillBindings: [
              { versionId: v1.id, entrypoints: script ? ["scripts/report.mjs"] : [] },
            ],
            maxSteps: 5,
          },
        })
      ).data,
    );
    const release = defined(
      (
        await sdk.publishAgent({
          client,
          path: { ...path, id: agent.id },
          body: { baseRevision: agent.draftRevision },
        })
      ).data,
    );
    assert.equal(release.snapshot.skills?.[0].id, v1.id);
    const conversation = defined(
      (await sdk.createConversation({ client, path, body: { agentId: agent.id } })).data,
    );
    const capabilities = defined(
      (await sdk.getConversationCapabilities({ client, path: { ...path, id: conversation.id } }))
        .data,
    );
    assert.deepEqual(
      capabilities.skills.map((s) => [s.versionId, s.enabled]),
      [[v1.id, true]],
    );
    assert.equal(
      (
        await sdk.getConversationCapabilities({
          client,
          path: { projectId: other.id, id: conversation.id },
          throwOnError: false,
        })
      ).response?.status,
      404,
    );
    assert.equal(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: "unbound",
            requestId: randomUUID(),
            skillVersionIds: [v2.id],
          },
          throwOnError: false,
        })
      ).response?.status,
      403,
    );
    const requestId = randomUUID();
    const run = defined(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: "使用 Skill 计算 40 与 80",
            requestId,
            skillVersionIds: [v1.id],
          },
        })
      ).data,
    );
    assert.deepEqual(run.selectedSkills, [{ versionId: v1.id, name: v1.name, version: 1 }]);
    assert.equal(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: JSON.stringify(["使用 Skill 计算 40 与 80", [v1.id]]),
            requestId,
          },
          throwOnError: false,
        })
      ).response?.status,
      409,
    );
    assert.equal(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: "使用 Skill 计算 40 与 80",
            requestId,
            skillVersionIds: [v1.id, v1.id],
          },
        })
      ).data?.id,
      run.id,
    );
    assert.equal(
      (
        await sdk.createRun({
          client,
          path,
          body: { conversationId: conversation.id, input: "使用 Skill 计算 40 与 80", requestId },
          throwOnError: false,
        })
      ).response?.status,
      409,
    );
    assert.deepEqual(
      (
        await sdk.listConversationRuns({ client, path: { ...path, id: conversation.id } })
      ).data?.map((r) => r.id),
      [run.id],
    );
    const denied = await fetch(`${baseUrl}/internal/runtime/runs/${run.id}/skills`, {
      method: "POST",
      headers: {
        authorization: "Bearer skill-test-token",
        "x-runtime-id": "hosted-local",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseToken: "wrong",
        versionId: v1.id,
        operation: "read",
        path: "SKILL.md",
      }),
    });
    assert.equal(denied.status, 403);
    worker = runWorker({
      controlPlaneUrl: baseUrl,
      runtimeId: "hosted-local",
      runtimeToken: "skill-test-token",
      logger: () => {},
      signal: stop.signal,
      skillSandboxImage: process.env.SKILL_TEST_IMAGE,
    });
    async function wait(id: string) {
      for (let i = 0; i < 400; i++) {
        const item = defined((await sdk.getRun({ client, path: { ...path, id } })).data);
        if (!["queued", "running"].includes(item.status)) return item;
        await new Promise((r) => setTimeout(r, 75));
      }
      throw new Error("Run timeout");
    }
    const completed = await wait(run.id);
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.match(model.systemPrompts[0], /用户为本次任务明确指定/);
    assert.match(model.systemPrompts[0], /ONE/);
    assert.doesNotMatch(model.systemPrompts[0], /TWO/);
    const events = defined(
        (await sdk.listRunEvents({ client, path: { ...path, id: run.id } })).data,
      ),
      outputs = events
        .filter((e) => e.chunk.type === "tool-output-available")
        .map((e) => e.chunk.output);
    const serialized = JSON.stringify(outputs);
    assert.match(serialized, /ONE/);
    assert.doesNotMatch(serialized, /TWO/);
    assert.match(serialized, /不得编造/);
    assert.equal(outputs.length, script ? 3 : 2);
    if (script) assert.match(serialized, /total.*120/);
    assert.ok(model.advertisedTools.has("skill"));
    assert.ok(model.advertisedTools.has("skill_read"));
    assert.equal(model.advertisedTools.has("mastra_workspace_execute_command"), false);
    const messages = defined(
      (await sdk.listMessages({ client, path: { ...path, id: conversation.id } })).data,
    );
    assert.match(JSON.stringify(messages), /ONE/);
    assert.equal(messages[0].metadata?.runId, run.id);
    assert.equal(messages[0].metadata?.selectedSkills?.[0].versionId, v1.id);
    const workflow = defined(
      (
        await sdk.createWorkflow({
          client,
          path,
          body: {
            name: "Skill workflow",
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
                  releaseId: release.id,
                  prompt: { kind: "literal", value: "Use the report skill" },
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
    const workflowRelease = defined(
      (
        await sdk.publishWorkflow({
          client,
          path: { ...path, id: workflow.id },
          body: { baseRevision: workflow.revision },
        })
      ).data,
    );
    const beforeWorkflow = model.toolResults.length;
    const workflowRun = defined(
      (
        await sdk.createWorkflowRun({
          client,
          path: { ...path, id: workflow.id },
          body: { releaseId: workflowRelease.id, input: {}, requestId: randomUUID() },
        })
      ).data,
    );
    let workflowStatus = "";
    for (let i = 0; i < 200; i++) {
      const item = defined(
        (await sdk.getWorkflowRun({ client, path: { ...path, id: workflowRun.id } })).data,
      );
      workflowStatus = item.status;
      if (!["queued", "running"].includes(item.status)) {
        assert.equal(item.status, "succeeded", JSON.stringify(item));
        break;
      }
      await new Promise((r) => setTimeout(r, 75));
    }
    assert.equal(workflowStatus, "succeeded");
    const workflowTools = JSON.stringify(model.toolResults.slice(beforeWorkflow));
    assert.match(workflowTools, /ONE/);
    if (script) assert.match(workflowTools, /total.*120/);
    await sdk.setSkillAccess({ client, path: { ...path, id: v1.id }, body: { enabled: false } });
    assert.equal(
      (await sdk.getConversationCapabilities({ client, path: { ...path, id: conversation.id } }))
        .data?.skills[0].enabled,
      false,
    );
    assert.equal(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: conversation.id,
            input: "revoked",
            requestId: randomUUID(),
            skillVersionIds: [v1.id],
          },
          throwOnError: false,
        })
      ).response?.status,
      403,
    );
    const before = model.calls,
      next = defined(
        (
          await sdk.createRun({
            client,
            path,
            body: { conversationId: conversation.id, input: "再次读取", requestId: randomUUID() },
          })
        ).data,
      );
    const revoked = await wait(next.id);
    assert.equal(revoked.status, "failed");
    assert.equal(revoked.errorCode, "SKILL_ACCESS_DENIED");
    assert.equal(model.calls, before);
    const slowModel = defined(
      (
        await sdk.createModel({
          client,
          path,
          body: {
            name: "Slow fixture",
            baseUrl: `${model.url}/v1`,
            modelId: "slow-fixture",
            apiKey: "fixture-key",
          },
        })
      ).data,
    );
    const slowAgent = defined(
      (
        await sdk.createAgent({
          client,
          path,
          body: {
            name: "Revocation",
            instructions: "Wait",
            modelId: slowModel.id,
            toolIds: [],
            skillBindings: [{ versionId: v2.id, entrypoints: [] }],
          },
        })
      ).data,
    );
    await sdk.publishAgent({
      client,
      path: { ...path, id: slowAgent.id },
      body: { baseRevision: slowAgent.draftRevision },
    });
    const slowConversation = defined(
      (await sdk.createConversation({ client, path, body: { agentId: slowAgent.id } })).data,
    );
    const activeRun = defined(
      (
        await sdk.createRun({
          client,
          path,
          body: {
            conversationId: slowConversation.id,
            input: "等待运行中撤销",
            requestId: randomUUID(),
          },
        })
      ).data,
    );
    let streaming = false;
    for (let i = 0; i < 100; i++) {
      const events =
        (await sdk.listRunEvents({ client, path: { ...path, id: activeRun.id } })).data ?? [];
      if (events.some((e) => e.chunk.type === "text-delta")) {
        streaming = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(streaming, "the model stream must start before revocation");
    await sdk.setSkillAccess({ client, path: { ...path, id: v2.id }, body: { enabled: false } });
    const interrupted = await wait(activeRun.id);
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.errorCode, "SKILL_ACCESS_DENIED");
  } finally {
    stop.abort();
    await worker;
    await model.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
