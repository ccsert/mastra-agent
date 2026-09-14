import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createRunBudget, type ModelSettlement } from "../../apps/runtime/src/agents/budget.ts";
import { agentJob } from "../fixtures/agent-job.ts";

test("provider SSE usage releases reservations and preserves the exact response", async () => {
  const wire = 'data: {"choices":[]}\n\ndata: {"usage":{"total_tokens":10}}\n\ndata: [DONE]\n\n';
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(wire.slice(0, 42));
    res.end(wire.slice(42));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const snapshot = agentJob().snapshot;
  snapshot.agent.executionLimits = {
    timeoutSeconds: 180,
    contextTokens: 4000,
    maxOutputTokens: 512,
    maxTokens: 1500,
    maxModelCalls: 2,
  };
  const settlements: ModelSettlement[] = [];
  let reservations = 0;
  const budget = createRunBudget(
    snapshot,
    async () => {
      reservations++;
    },
    async (value) => {
      settlements.push(value);
    },
  );
  try {
    for (let index = 0; index < 2; index++) {
      const response = await budget.fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body: "a".repeat(700),
      });
      assert.equal(await response.text(), wire);
    }
    assert.equal(reservations, 2);
    assert.deepEqual(
      settlements.map((s) => s.actualTokens),
      [10, 10],
    );
    await assert.rejects(budget.fetch(`http://127.0.0.1:${address.port}`), /MODEL_CALL_LIMIT/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a response without reported usage retains its reservation", async () => {
  const snapshot = agentJob().snapshot;
  snapshot.agent.executionLimits = {
    timeoutSeconds: 180,
    contextTokens: 4000,
    maxOutputTokens: 512,
    maxTokens: 1000,
    maxModelCalls: 10,
  };
  const budget = createRunBudget(snapshot);
  const response = await budget.fetch("data:text/event-stream,data: [DONE]%0A%0A");
  await response.text();
  await assert.rejects(budget.fetch("data:text/event-stream,data: [DONE]%0A%0A"), /TOKEN_BUDGET/);
});
