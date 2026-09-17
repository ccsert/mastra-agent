import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { summarizeWithPrefix } from "../../apps/runtime/src/agents/compaction-prefix.ts";

type Recorded = { type: string; data?: unknown };

function recorder() {
  const events: Recorded[] = [];
  return {
    events,
    emit: async (chunk: { type: string; data?: unknown }) => {
      events.push(chunk);
    },
  };
}

/** Serves one SSE completion and records the request body it received. */
async function modelServer(frames: string[], status = 200) {
  const received: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(status, { "content-type": "text/event-stream" });
      for (const frame of frames) response.write(frame);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const delta = (content: string, extra = "") =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}${extra}\n\n`;
const usageFrame = (details: Record<string, unknown>) =>
  `data: ${JSON.stringify({ choices: [], usage: details })}\n\n`;

test("replays the recorded prefix verbatim and appends the instruction", async () => {
  const server = await modelServer([
    delta("## 用户目标与意图\n"),
    delta("- 继续任务"),
    usageFrame({
      prompt_tokens: 12000,
      completion_tokens: 300,
      total_tokens: 12300,
      prompt_tokens_details: { cached_tokens: 11000 },
    }),
    "data: [DONE]\n\n",
  ]);
  try {
    const { events, emit } = recorder();
    const result = await summarizeWithPrefix({
      prefix: {
        model: "fixture-chat",
        messages: [
          { role: "system", content: "系统提示词" },
          { role: "user", content: "原始需求" },
          { role: "assistant", content: "已完成一部分" },
        ],
        tools: [{ type: "function", function: { name: "demo" } }],
        toolChoice: "auto",
        temperature: 0.3,
        maxTokens: 512,
      },
      instruction: "压缩指令",
      stepIndex: 0,
      requestIndex: 7,
      baseUrl: server.baseUrl,
      apiKey: "fixture-key",
      signal: new AbortController().signal,
      emit,
    });
    // The sent body is the recorded prefix plus exactly one instruction turn.
    const [sent] = server.received;
    assert.ok(sent);
    const messages = sent.messages as Record<string, unknown>[];
    assert.equal(messages.length, 4);
    assert.deepEqual(messages.slice(0, 3), [
      { role: "system", content: "系统提示词" },
      { role: "user", content: "原始需求" },
      { role: "assistant", content: "已完成一部分" },
    ]);
    assert.deepEqual(messages[3], { role: "user", content: "压缩指令" });
    assert.equal(sent.model, "fixture-chat");
    assert.equal(sent.stream, true);
    // A summary must not be capped by an answer-sized limit.
    assert.equal(sent.max_tokens, 8192);
    assert.equal(sent.tool_choice, "auto");
    assert.ok(Array.isArray(sent.tools));
    // The trace records the replayed request and its provider-reported usage.
    const requestEvent = events.find((event) => event.type === "data-model-request");
    assert.ok(requestEvent);
    assert.equal(
      ((requestEvent.data as Record<string, unknown>).request as Record<string, unknown>).model,
      "fixture-chat",
    );
    const timing = events.find((event) => event.type === "data-model-response") as
      | { data?: Record<string, unknown> }
      | undefined;
    assert.equal(timing?.data?.outcome, "completed");
    assert.equal(result.text, "## 用户目标与意图\n- 继续任务");
    assert.equal(result.usage.inputTokens, 12000);
    assert.equal(result.usage.cachedInputTokens, 11000);
    assert.equal(result.finishReason, null);
  } finally {
    await server.close();
  }
});

test("a truncated checkpoint never returns usable summary text", async () => {
  const server = await modelServer([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "被截断" }, finish_reason: "length" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
  try {
    const { emit } = recorder();
    await assert.rejects(
      summarizeWithPrefix({
        prefix: { model: "fixture-chat", messages: [{ role: "user", content: "x" }] },
        instruction: "压缩",
        stepIndex: 0,
        requestIndex: 1,
        baseUrl: server.baseUrl,
        apiKey: "",
        signal: new AbortController().signal,
        emit,
      }),
      /MODEL_ERROR/,
    );
  } finally {
    await server.close();
  }
});

test("provider errors fail the call and are recorded as failed, not omitted", async () => {
  const server = await modelServer([], 500);
  try {
    const { events, emit } = recorder();
    await assert.rejects(
      summarizeWithPrefix({
        prefix: { model: "fixture-chat", messages: [{ role: "user", content: "x" }] },
        instruction: "压缩",
        stepIndex: 0,
        requestIndex: 2,
        baseUrl: server.baseUrl,
        apiKey: "",
        signal: new AbortController().signal,
        emit,
      }),
      /MODEL_ERROR/,
    );
    const timing = events.find((event) => event.type === "data-model-response") as
      | { data?: Record<string, unknown> }
      | undefined;
    assert.equal(timing?.data?.outcome, "failed");
    assert.equal(timing?.data?.httpStatus, 500);
  } finally {
    await server.close();
  }
});
