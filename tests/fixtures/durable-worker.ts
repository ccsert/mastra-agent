import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TaskAccess } from "../../apps/runtime/src/agents/durable.ts";
import { executeJob } from "../../apps/runtime/src/agents/execute.ts";
import { ExecutionJob } from "../../packages/contracts/src/index.ts";

// A separate OS process is intentional: no Agent registry or closure survives recovery.
const [path, mode] = process.argv.slice(2);
const state = JSON.parse(readFileSync(path, "utf8"));
const save = () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
};
const job = ExecutionJob.parse(state.job);
if (mode === "recover") {
  job.recoveryCount = 1;
  job.nextEventSeq = state.events.length;
  job.nextStepIndex = 1;
}
const task: TaskAccess = async (input) => {
  const now = new Date().toISOString();
  if (input.operation === "save")
    state.snapshots[input.workflowName] = {
      runId: job.runId,
      workflowName: input.workflowName,
      snapshot: input.snapshot,
      createdAt: now,
      updatedAt: now,
    };
  if (input.operation === "load")
    return { snapshot: state.snapshots[input.workflowName]?.snapshot ?? null };
  if (input.operation === "list")
    return { runs: Object.values(state.snapshots), total: Object.keys(state.snapshots).length };
  if (input.operation === "delete") delete state.snapshots[input.workflowName];
  if (input.operation === "tool-start") {
    const previous = state.receipts[input.callId];
    if (previous?.status === "running") throw new Error("TOOL_OUTCOME_UNKNOWN");
    if (previous) return { cached: true, output: previous.output };
    state.receipts[input.callId] = { status: "running" };
    save();
    return { cached: false };
  }
  if (input.operation === "tool-finish")
    state.receipts[input.callId] = { status: "succeeded", output: input.output };
  save();
  return { ok: true };
};
let calls = 0;
try {
  const message = await executeJob(
    job,
    AbortSignal.timeout(20000),
    async (chunk) => {
      state.events.push(chunk);
      save();
      if (mode === "crash" && chunk.type === "data-model-request" && ++calls === 2)
        process.exit(93);
    },
    {
      task,
      authorizeMcp: async () => ({}),
      queryKnowledge: async () => ({}),
      reserveModel: async () => {
        state.reservations++;
        save();
      },
    },
  );
  state.result = message;
  save();
} catch (error) {
  state.error = String(error);
  save();
  process.exitCode = 1;
}
