import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeJob } from "../../apps/runtime/src/agents/execute.ts";
import { agentJob } from "../fixtures/agent-job.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";

if (!process.env.TASK_SANDBOX_IMAGE)
  console.warn(
    "[web-workspace.test] TASK_SANDBOX_IMAGE is not set; Docker browser sandbox coverage will be skipped",
  );

test("a workspace agent without provisioned sandbox env fails fast with a named error", async () => {
  const job = agentJob();
  job.snapshot.agent.workspaceEnabled = true;
  await assert.rejects(
    executeJob(job, AbortSignal.timeout(5000), async () => {}),
    /WORKSPACE_NOT_CONFIGURED/,
  );
});

test("model loop writes a webpage, runs it, inspects a real browser and exports bytes", {
  skip: process.env.TASK_SANDBOX_IMAGE
    ? false
    : "TASK_SANDBOX_IMAGE is not set; browser sandbox coverage is skipped",
  timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "platform-web-test-"));
  const fixture = await startModelFixture(0, {
    toolSequence: [
      {
        name: "mastra_workspace_write_file",
        input: {
          path: "index.html",
          content:
            '<!doctype html><html><head><title>violet-317</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>violet-317</h1><button onclick="this.textContent=\'Clicked\'">Try</button></body></html>',
          overwrite: true,
        },
      },
      {
        name: "mastra_workspace_execute_command",
        input: {
          command: "python3 -m http.server 5173 --bind 127.0.0.1 >/tmp/server.log 2>&1 &",
          timeout: 5000,
        },
      },
      { name: "browser_goto", input: { url: "http://127.0.0.1:5173" } },
      { name: "browser_snapshot", input: {} },
      { name: "browser_click", input: { ref: "@e1" } },
      { name: "browser_snapshot", input: {} },
      { name: "browser_check", input: { width: 390, height: 844 } },
      { name: "browser_screenshot", input: { fullPage: false } },
      { name: "workspace_publish", input: { path: "index.html" } },
    ],
    answer: "Fixture delivered a verified webpage.",
  });
  const job = agentJob(`${fixture.url}/v1`);
  job.snapshot.agent.workspaceEnabled = true;
  const artifacts: Array<{ name: string; mediaType: string; contentBase64: string }> = [];
  try {
    await executeJob(job, AbortSignal.timeout(110000), async () => {}, {
      taskWorkspaceRoot: root,
      taskSandboxImage: process.env.TASK_SANDBOX_IMAGE,
      uploadArtifact: async (input) => {
        artifacts.push(input);
        return { id: `artifact-${artifacts.length}` };
      },
      authorizeMcp: async () => ({}),
      queryKnowledge: async () => ({}),
    });
    assert.match(
      await readFile(join(root, job.conversationId ?? "", "project/index.html"), "utf8"),
      /violet-317/,
    );
    const checks = fixture.toolResults.find((result) =>
      JSON.stringify(result).includes("horizontalOverflow"),
    );
    assert.ok(checks, "real browser diagnostics reached the model");
    assert.match(JSON.stringify(checks), /violet-317/);
    assert.match(JSON.stringify(checks), /127.0.0.1:5173/);
    assert.ok(
      artifacts.some(
        (a) =>
          a.mediaType === "image/png" &&
          Buffer.from(a.contentBase64, "base64").subarray(1, 4).toString() === "PNG",
      ),
    );
    assert.ok(artifacts.some((a) => a.mediaType === "text/html"));
    assert.equal(fixture.calls, 10);
    assert.ok(fixture.imageInputs > 0, "PNG image bytes reached the model request");
    assert.match(JSON.stringify(fixture.toolResults), /Clicked/);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
