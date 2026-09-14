import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeJob } from "../../apps/runtime/src/agents/execute.ts";
import { agentJob } from "../fixtures/agent-job.ts";
import { startModelFixture } from "../fixtures/model-fixture.ts";

test("80 native model steps complete without invented user continuation turns", {
  timeout: 60000,
}, async () => {
  const fixture = await startModelFixture(0, {
    sequenceByRequest: true,
    toolSequence: Array.from({ length: 79 }, () => ({ name: "task_read_progress", input: {} })),
    answer: "Done at step 80.",
  });
  const job = agentJob(`${fixture.url}/v1`);
  assert.ok(job.snapshot.agent.executionLimits);
  job.snapshot.agent.executionLimits.contextTokens = 8000;
  job.taskState = {
    baseRevision: 0,
    revision: 1,
    runId: job.runId,
    objective: "Keep violet-317",
    constraints: ["Keep the original title"],
    progress: "工作记录用于验证上下文裁剪。".repeat(100),
    nextSteps: ["Finish the fixture"],
    evidence: [],
    status: "in_progress",
  };
  let trimmed = 0;
  try {
    let calls = 0;
    const snapshots = new Map<string, unknown>();
    const result = await executeJob(
      job,
      AbortSignal.timeout(55000),
      async (chunk) => {
        if (chunk.type === "data-context-trim") trimmed++;
      },
      {
        task: async (input) => {
          if (input.operation === "load")
            return { snapshot: snapshots.get(input.workflowName) ?? null };
          if (input.operation === "save")
            snapshots.set(input.workflowName, structuredClone(input.snapshot));
          if (input.operation === "tool-start") return { cached: false };
          if (input.operation === "list") return { runs: [], total: 0 };
          return { ok: true };
        },
        reserveModel: async () => {
          calls++;
        },
        authorizeMcp: async () => ({}),
        queryKnowledge: async () => ({}),
      },
    );
    assert.equal(fixture.calls, 80);
    assert.equal(calls, 80);
    assert.ok(trimmed > 0, "long model context was actually trimmed");
    assert.match(JSON.stringify(result), /Done at step 80/);
    assert.equal(job.messages.length, 1);
    assert.ok(fixture.systemPrompts.every((prompt) => prompt.includes("violet-317")));
  } finally {
    await fixture.close();
  }
});

test("fresh process recovery uses persisted native snapshots and preserves tool hooks and budget", {
  timeout: 45000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "platform-recover-test-")),
    path = join(directory, "state.json");
  const fixture = await startModelFixture(0, {
    toolSequence: [
      { name: "task_read_progress", input: {} },
      { name: "task_read_progress", input: {} },
    ],
    answer: "Recovered.",
  });
  const job = agentJob(`${fixture.url}/v1`);
  job.snapshot.agent.maxSteps = 3;
  job.snapshot.agent.planningEnabled = true;
  await writeFile(
    path,
    JSON.stringify({ job, events: [], snapshots: {}, receipts: {}, reservations: 0 }),
  );
  const run = (mode: string) =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          "tsx",
          "tests/fixtures/durable-worker.ts",
          path,
          mode,
        ],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", resolve);
    });
  try {
    assert.equal(await run("crash"), 93);
    assert.equal(await run("recover"), 0, await readFile(path, "utf8"));
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.match(JSON.stringify(state.result), /Recovered/);
    assert.equal(fixture.calls, 3);
    assert.equal(state.reservations, 3);
    assert.equal(
      Object.keys(state.receipts).length,
      2,
      JSON.stringify({
        receipts: state.receipts,
        tools: state.events.filter((e: { type: string }) => e.type.includes("tool")),
      }),
    );
    assert.equal(
      state.events.filter((event: { type: string }) => event.type === "data-tool-execution").length,
      2,
    );
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unacknowledged tool receipt stops the model instead of repeating its effect", async () => {
  const fixture = await startModelFixture(0, {
    toolSequence: [{ name: "task_read_progress", input: {} }],
  });
  const job = agentJob(`${fixture.url}/v1`);
  let finishes = 0;
  try {
    await assert.rejects(
      executeJob(job, AbortSignal.timeout(15000), async () => {}, {
        task: async (input) => {
          if (input.operation === "load") return { snapshot: null };
          if (input.operation === "tool-start") return { cached: false };
          if (input.operation === "tool-finish") {
            finishes++;
            throw new Error("connection lost");
          }
          if (input.operation === "list") return { runs: [], total: 0 };
          return { ok: true };
        },
        authorizeMcp: async () => ({}),
        queryKnowledge: async () => ({}),
      }),
      /TOOL_OUTCOME_UNKNOWN/,
    );
    assert.equal(finishes, 1);
    assert.equal(fixture.calls, 1);
  } finally {
    await fixture.close();
  }
});
