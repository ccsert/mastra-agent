import assert from "node:assert/strict";
import test from "node:test";
import { executeWorkflow } from "../../apps/runtime/src/workflows/execute.ts";
import { WorkflowSnapshot } from "../../packages/contracts/src/index.ts";

const definition = {
  inputSchema: {
    type: "object",
    properties: { found: { type: "boolean" } },
    required: ["found"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { report: { type: "string" } },
    required: ["report"],
    additionalProperties: false,
  },
  nodes: [
    { id: "start", type: "start", label: "输入" },
    {
      id: "check",
      type: "condition",
      label: "判断",
      left: { kind: "ref", path: "input.found" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    {
      id: "found",
      type: "end",
      label: "有订单",
      values: { report: { kind: "literal", value: "报告" } },
    },
    {
      id: "missing",
      type: "end",
      label: "无订单",
      values: { report: { kind: "literal", value: "订单不存在" } },
    },
  ],
  edges: [
    { source: "start", target: "check", port: "out" },
    { source: "check", target: "found", port: "true" },
    { source: "check", target: "missing", port: "false" },
  ],
};
test("Mastra executes exactly the selected branch and fences failures/cancellation", async () => {
  const snapshot = WorkflowSnapshot.parse({
    definition,
    tools: [],
    agents: [],
    catalog: [],
    adapterVersion: "mastra-workflow-v1",
  });
  for (const found of [true, false]) {
    const started: string[] = [],
      finished: string[] = [];
    const result = await executeWorkflow(snapshot, { found }, new AbortController().signal, {
      start: async (node) => {
        started.push(node.id);
      },
      invoke: async () => {
        throw new Error("Unexpected business call");
      },
      finish: async (node) => {
        finished.push(node.id);
      },
    });
    assert.deepEqual(result, { report: found ? "报告" : "订单不存在" });
    assert.deepEqual(started, ["start", "check", found ? "found" : "missing"]);
    assert.deepEqual(finished, started);
  }
  const invoked: string[] = [];
  await assert.rejects(
    () =>
      executeWorkflow(snapshot, { found: true }, new AbortController().signal, {
        start: async (node) => {
          invoked.push(node.id);
          if (node.id === "check") throw new Error("LEASE_EXPIRED");
        },
        invoke: async () => null,
        finish: async () => {},
      }),
    /LEASE_EXPIRED/,
  );
  assert.deepEqual(invoked, ["start", "check"]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() =>
    executeWorkflow(snapshot, { found: false }, abort.signal, {
      start: async () => {
        assert.fail();
      },
      invoke: async () => null,
      finish: async () => {},
    }),
  );
});
