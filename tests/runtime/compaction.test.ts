import assert from "node:assert/strict";
import test from "node:test";
import { compactConversation } from "../../apps/runtime/src/agents/compaction.ts";
import { assistantToolDefinitions, RunUsage, z } from "../../packages/contracts/src/index.ts";
import { agentJob } from "../fixtures/agent-job.ts";

test("rolling compaction reads every source character and shows only the final summary", async () => {
  const job = agentJob();
  assert.ok(job.snapshot.agent.executionLimits);
  job.snapshot.agent.executionLimits.contextTokens = 4000;
  const transcript = `最初目标\n${"规则和路径/证据😺".repeat(800)}\n最后一条纠正`;
  job.compaction = { transcript, focus: "保留证据" };
  const chunks: Parameters<Parameters<typeof compactConversation>[2]>[0][] = [],
    seen: string[] = [];
  let pass = 0;
  const final = await compactConversation(
    job,
    new AbortController().signal,
    async (chunk) => {
      chunks.push(chunk);
    },
    async (next, emit) => {
      const text = String(next.messages[0].parts[0].text);
      assert.ok(text.includes(pass === 0 ? "已有摘要：无" : `已有摘要：摘要 ${pass}`));
      seen.push(text.split(/新增材料[^\n]*\n/)[1]);
      await emit({ type: "data-model-request", data: { pass }, transient: true });
      await emit({ type: "text-delta", id: `p-${pass}`, delta: `摘要 ${++pass}` });
      return {
        id: `summary-${pass}`,
        role: "assistant",
        parts: [{ type: "text", text: `摘要 ${pass}` }],
      };
    },
  );
  assert.equal(seen.join(""), transcript);
  assert.ok(pass > 1);
  assert.equal(chunks.filter((c) => c.type === "data-model-request").length, pass);
  assert.equal(chunks.filter((c) => c.type === "text-delta").length, 1);
  assert.equal(final.id, `summary-${pass}`);
});

test("empty summaries and cancelled passes never return a usable checkpoint", async () => {
  const job = agentJob();
  job.compaction = { transcript: "历史原文", focus: "" };
  await assert.rejects(
    compactConversation(
      job,
      new AbortController().signal,
      async () => {},
      async () => ({ id: "empty", role: "assistant", parts: [] }),
    ),
    /MODEL_ERROR/,
  );
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    compactConversation(
      job,
      controller.signal,
      async () => {},
      async () => {
        called = true;
        return { id: "bad", role: "assistant", parts: [] };
      },
    ),
  );
  assert.equal(called, false);
});

test("page tool publishes an object schema compatible with OpenAI function calling", () => {
  const schema = z.toJSONSchema(assistantToolDefinitions.platform_ui.inputSchema);
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
});

test("compaction aggregates every pass usage and preserves unknown metrics", async () => {
  const job = agentJob();
  assert.ok(job.snapshot.agent.executionLimits);
  job.snapshot.agent.executionLimits.contextTokens = 4000;
  job.compaction = { transcript: "字".repeat(3000), focus: "" };
  const totals: RunUsage[] = [];
  let pass = 0;
  await compactConversation(
    job,
    new AbortController().signal,
    async (chunk) => {
      if (chunk.type === "data-run-usage") totals.push(RunUsage.parse(chunk.data));
    },
    async (_next, emit) => {
      pass++;
      const usage = {
        inputTokens: 100 * pass,
        outputTokens: 10,
        totalTokens: 100 * pass + 10,
        reasoningTokens: pass === 1 ? 5 : null,
        cachedInputTokens: 0,
      };
      await emit({
        type: "data-run-usage",
        data: {
          usage,
          steps: 1,
          finishReason: "stop",
          traceId: `trace-${pass}`,
          spanId: null,
          perStep: [{ stepIndex: 0, modelId: "test", finishReason: "stop", usage }],
        },
      });
      return { id: `summary-${pass}`, role: "assistant", parts: [{ type: "text", text: "摘要" }] };
    },
  );
  assert.equal(totals.length, 1);
  assert.deepEqual(totals[0].usage, {
    inputTokens: 300,
    outputTokens: 20,
    totalTokens: 320,
    reasoningTokens: null,
    cachedInputTokens: 0,
  });
  assert.equal(totals[0].steps, 2);
  assert.deepEqual(
    totals[0].perStep.map((step) => step.stepIndex),
    [0, 1],
  );
  assert.equal(totals[0].traceId, null);
});
