import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkflowValue,
  evaluateCondition,
  resolveMappings,
  validateWorkflow,
  validateWorkflowProposal,
  WorkflowDefinition,
  workflowExecutionDefinition,
} from "../packages/contracts/src/index.ts";

export function sampleWorkflow() {
  return WorkflowDefinition.parse({
    inputSchema: {
      type: "object",
      properties: { amount: { type: "number", minimum: 0 } },
      required: ["amount"],
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
        label: "判断金额",
        left: { kind: "ref", path: "input.amount" },
        operator: "gt",
        right: { kind: "literal", value: 0 },
      },
      {
        id: "found",
        type: "end",
        label: "有金额",
        values: { report: { kind: "template", template: `金额 \${input.amount}` } },
      },
      {
        id: "empty",
        type: "end",
        label: "无金额",
        values: { report: { kind: "literal", value: "无订单" } },
      },
    ],
    edges: [
      { source: "start", target: "check", port: "out" },
      { source: "check", target: "found", port: "true" },
      { source: "check", target: "empty", port: "false" },
    ],
  });
}

test("workflow validation binds variables to their branch, checks types and rejects malformed graphs", () => {
  const sample = sampleWorkflow();
  assert.deepEqual(validateWorkflow(sample, []), []);
  for (const mutate of [
    (d: WorkflowDefinition) => {
      d.edges[2].port = "true";
    },
    (d: WorkflowDefinition) => {
      d.edges[2].target = "found";
    },
    (d: WorkflowDefinition) => {
      d.nodes.push(d.nodes[0]);
    },
    (d: WorkflowDefinition) => {
      if (d.nodes[2].type === "end")
        d.nodes[2].values.report = { kind: "ref", path: "nodes.empty.report" };
    },
    (d: WorkflowDefinition) => {
      if (d.nodes[2].type === "end")
        d.nodes[2].values.report = { kind: "ref", path: "input.amount" };
    },
    (d: WorkflowDefinition) => {
      if (d.nodes[2].type === "end")
        d.nodes[2].values.report = { kind: "template", template: `\${input.amount + 1}` };
    },
    (d: WorkflowDefinition) => {
      d.inputSchema.required = [];
    },
    (d: WorkflowDefinition) => {
      d.inputSchema = {
        type: "object",
        properties: { unsafe: { type: "string", pattern: "(a+)+$" } },
      };
    },
  ]) {
    const copy = structuredClone(sample);
    mutate(copy);
    assert.notDeepEqual(validateWorkflow(copy, []), []);
  }
  assert.throws(
    () => assertWorkflowValue(sample.inputSchema, { amount: -1 }),
    /WORKFLOW_VALUE_INVALID/,
  );
  assert.throws(
    () => assertWorkflowValue(sample.inputSchema, { amount: "2" }),
    /WORKFLOW_VALUE_INVALID/,
  );
  assert.throws(() => resolveMappings({ x: { kind: "ref", path: "input.constructor" } }, {}, {}));
  assert.throws(() =>
    assertWorkflowValue({ type: "object" }, JSON.parse('{"__proto__":{"bad":1}}')),
  );
});

test("workflow templates and mutually exclusive condition preserve values; labels and array order do not alter execution", () => {
  const sample = sampleWorkflow(),
    condition = sample.nodes[1];
  assert.equal(condition.type, "condition");
  if (condition.type !== "condition") throw new Error("Fixture invalid");
  assert.equal(evaluateCondition(condition, { amount: 12 }, {}), true);
  assert.equal(evaluateCondition(condition, { amount: 0 }, {}), false);
  assert.deepEqual(
    resolveMappings(
      { report: { kind: "template", template: `订单 \${nodes.order.data}` } },
      {},
      { order: { data: { status: "待发货" } } },
    ),
    { report: '订单 {"status":"待发货"}' },
  );
  const copy = structuredClone(sample);
  copy.nodes.reverse();
  copy.edges.reverse();
  copy.nodes[0].label = "新名称";
  assert.deepEqual(workflowExecutionDefinition(copy), workflowExecutionDefinition(sample));
});

test("mapped literal arrays cannot conceal an incompatible later element", () => {
  const definition = WorkflowDefinition.parse({
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      properties: { values: { type: "array", items: { type: "integer" } } },
      required: ["values"],
    },
    nodes: [
      { id: "start", type: "start", label: "开始" },
      {
        id: "mapping",
        type: "map",
        label: "映射",
        values: { values: { kind: "literal", value: [1, "bad"] } },
      },
      {
        id: "end",
        type: "end",
        label: "结束",
        values: { values: { kind: "ref", path: "nodes.mapping.values" } },
      },
    ],
    edges: [
      { source: "start", target: "mapping", port: "out" },
      { source: "mapping", target: "end", port: "out" },
    ],
  });
  assert.ok(validateWorkflow(definition, []).length);
  const mapping = definition.nodes[1];
  if (mapping.type !== "map") throw new Error("Invalid fixture");
  mapping.values.values = { kind: "literal", value: [1, 2] };
  assert.deepEqual(validateWorkflow(definition, []), []);
  definition.outputSchema = {
    type: "object",
    properties: { values: { type: "array", items: { type: "number" } } },
    required: ["values"],
  };
  mapping.values.values = { kind: "literal", value: [1, 1.5] };
  assert.deepEqual(validateWorkflow(definition, []), []);
  definition.outputSchema = {
    type: "object",
    properties: {
      values: {
        type: "array",
        items: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
    },
    required: ["values"],
  };
  mapping.values.values = {
    kind: "literal",
    value: [
      { a: 1, b: "x" },
      { b: "y", a: 1.5 },
    ],
  };
  assert.deepEqual(validateWorkflow(definition, []), []);
});

test("AI proposals that merely copy the draft are not accepted as completed edits", () => {
  const base = sampleWorkflow(),
    candidate = structuredClone(base);
  candidate.nodes.reverse();
  candidate.edges.reverse();
  assert.equal(validateWorkflowProposal(candidate, base, [])[0]?.code, "NO_CHANGES");
  candidate.nodes[0].label = "修改节点名称";
  assert.deepEqual(validateWorkflowProposal(candidate, base, []), []);
});
