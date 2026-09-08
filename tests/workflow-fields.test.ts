import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowNode } from "@platform/sdk";
import {
  conditionTypeIssue,
  describeBinding,
  promptVariables,
} from "../apps/console/src/workflow-field-model.ts";
import { evaluateCondition } from "../packages/contracts/src/workflow-definition.ts";

const options = [
  { value: "input.total", label: "流程输入.total · number", type: "number", optional: false },
  {
    value: "nodes.order.status",
    label: "查询订单.status · string",
    type: "string",
    optional: false,
  },
];
const rule: Extract<WorkflowNode, { type: "condition" }> = {
  id: "check",
  label: "判断",
  type: "condition",
  operator: "gte",
  left: { kind: "ref", path: "input.total" },
  right: { kind: "literal", value: 100 },
};
test("condition form matches executor numeric and equality type rules", () => {
  assert.equal(conditionTypeIssue(rule, options), undefined);
  assert.equal(evaluateCondition(rule, { total: 100 }, {}), true);
  assert.match(
    conditionTypeIssue({ ...rule, right: { kind: "literal", value: "100" } }, options) ?? "",
    /数值/,
  );
  const comparison: typeof rule = {
    ...rule,
    operator: "eq",
    left: { kind: "ref", path: "nodes.order.status" },
    right: { kind: "literal", value: "不存在" },
  };
  assert.equal(conditionTypeIssue(comparison, options), undefined);
  assert.equal(evaluateCondition(comparison, {}, { order: { status: "不存在" } }), true);
  assert.match(
    conditionTypeIssue({ ...comparison, right: { kind: "literal", value: false } }, options) ?? "",
    /类型必须一致/,
  );
  assert.match(
    conditionTypeIssue({ ...comparison, left: { kind: "literal", value: {} } }, options) ?? "",
    /具体字段/,
  );
});
test("exists explicitly treats empty string, zero and false as present", () => {
  const { right: _right, ...base } = rule;
  for (const value of ["", 0, false, [], {}]) {
    const exists: typeof rule = { ...base, operator: "exists", left: { kind: "literal", value } };
    assert.equal(conditionTypeIssue(exists, options), undefined);
    assert.equal(evaluateCondition(exists, {}, {}), true);
  }
  assert.equal(
    evaluateCondition(
      { ...base, operator: "exists", left: { kind: "literal", value: null } },
      {},
      {},
    ),
    false,
  );
});
test("prompt references use the published DSL and readable labels without rewriting text", () => {
  const prompt =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Published workflow template syntax is intentionally literal.
    "# 报告\n状态：${nodes.order.status}\n金额：${input.total}\n再次引用 ${input.total}\n{{ not_a_platform_variable }}";
  assert.deepEqual(promptVariables(prompt), ["nodes.order.status", "input.total"]);
  assert.equal(
    describeBinding({ kind: "ref", path: "nodes.order.status" }, options),
    "查询订单.status",
  );
  assert.equal(describeBinding({ kind: "literal", value: "100" }, options), '"100"');
  assert.equal(describeBinding({ kind: "literal", value: 100 }, options), "100");
});
