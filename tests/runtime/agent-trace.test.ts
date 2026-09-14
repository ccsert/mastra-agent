import assert from "node:assert/strict";
import test from "node:test";
import { tracedModelFetch } from "../../apps/runtime/src/agents/trace.ts";
import { ModelRequestTiming } from "../../packages/contracts/src/index.ts";

type Recorded = { type: string; transient?: boolean; data?: Record<string, unknown> };

function recorder() {
  const events: Recorded[] = [];
  return {
    events,
    onChunk: async (chunk: Recorded) => {
      events.push(chunk);
    },
    all: (type: string) => events.filter((event) => event.type === type),
  };
}

const encoder = new TextEncoder(),
  modelBody = JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "hi" }] }),
  completion = "data: he\n\ndata: llo\n\ndata: [DONE]\n\n";

const respond = (parts: string[], status = 200) =>
  Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      }),
      { status },
    ),
  );

test("a streamed model response is timed, byte-counted and passed through unchanged", async () => {
  const { onChunk, all } = recorder();
  let clock = 1_000;
  const fetchImpl = tracedModelFetch(
    onChunk as never,
    (() => respond([completion.slice(0, 8), completion.slice(8)])) as typeof fetch,
    () => (clock += 5),
  );
  const response = await fetchImpl("http://model/v1/chat/completions", { body: modelBody });
  assert.equal(await response.text(), completion);

  const [request] = all("data-model-request"),
    [timing] = all("data-model-response");
  assert.equal(request?.transient, true);
  assert.equal(request?.data?.requestIndex, 1);
  assert.equal(timing?.data?.requestIndex, 1);
  assert.equal(timing?.data?.httpStatus, 200);
  assert.equal(timing?.data?.outcome, "completed");
  assert.equal(timing?.data?.responseBytes, encoder.encode(completion).byteLength);
  const firstByteMs = Number(timing?.data?.firstByteMs),
    durationMs = Number(timing?.data?.durationMs);
  assert.ok(Number.isFinite(firstByteMs) && firstByteMs >= 0, "first response byte is timed");
  assert.ok(durationMs >= firstByteMs, "the response cannot finish before its first byte");
  // The recorded payload is the contract's shape, not an ad-hoc object.
  assert.equal(ModelRequestTiming.safeParse(timing?.data).success, true);
});

test("a cancelled model response is recorded as incomplete, never as complete", async () => {
  const { onChunk, all } = recorder();
  const fetchImpl = tracedModelFetch(
    onChunk as never,
    (() => respond(["data: par", "tial\n\n"])) as typeof fetch,
    () => Date.now(),
  );
  const response = await fetchImpl("http://model/v1/chat/completions", { body: modelBody });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel();
  assert.equal(all("data-model-response").length, 1);
  assert.equal(all("data-model-response")[0]?.data?.outcome, "incomplete");
});

test("a model request that never produced a response is recorded as failed", async () => {
  const { onChunk, all } = recorder();
  const fetchImpl = tracedModelFetch(
    onChunk as never,
    (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    () => Date.now(),
  );
  await assert.rejects(
    () => fetchImpl("http://model/v1/chat/completions", { body: modelBody }),
    /ECONNREFUSED/,
  );
  const [timing] = all("data-model-response");
  assert.equal(timing?.data?.outcome, "failed");
  assert.equal(timing?.data?.httpStatus, null);
  assert.equal(all("data-model-request").length, 1);
});

test("a non-JSON string body is not recorded as a model request but its response still is", async () => {
  const { onChunk, all } = recorder();
  const fetchImpl = tracedModelFetch(
    onChunk as never,
    (() => respond(["{}"])) as typeof fetch,
    () => Date.now(),
  );
  // A body that is not JSON must not turn into a failed model call.
  const response = await fetchImpl("http://model/v1/embeddings", { body: "not-json" });
  assert.equal(await response.text(), "{}");
  assert.equal(all("data-model-request").length, 0);
  assert.equal(all("data-model-response").length, 1);
});

test("every transport call is numbered so a response always joins its request", async () => {
  const { onChunk, all } = recorder();
  const fetchImpl = tracedModelFetch(
    onChunk as never,
    (() => respond(["{}"])) as typeof fetch,
    () => Date.now(),
  );
  await (await fetchImpl("http://model/v1/chat/completions", { body: modelBody })).text();
  await (await fetchImpl("http://model/v1/chat/completions", { body: modelBody })).text();
  const responses = all("data-model-response").map((event) => event.data?.requestIndex);
  const requests = all("data-model-request").map((event) => event.data?.requestIndex);
  assert.deepEqual(responses, [1, 2]);
  assert.deepEqual(requests, responses);
});
