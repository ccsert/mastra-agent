import assert from "node:assert/strict";
import test from "node:test";
import { connectionIssue, emptyWorkflow } from "../apps/console/src/workflow-model.ts";

test("editor connections enforce the executable tree without rejecting a valid branch", () => {
  const { definition } = emptyWorkflow("编辑器连线");
  definition.nodes.push(
    {
      id: "check",
      type: "condition",
      label: "判断",
      left: { kind: "literal", value: true },
      operator: "exists",
    },
    { id: "other", type: "end", label: "另一条路径", values: {} },
  );
  definition.edges = [{ source: "start", target: "check", port: "out" }];
  assert.equal(connectionIssue(definition, "check", "end", "true"), undefined);
  definition.edges.push({ source: "check", target: "end", port: "true" });
  assert.equal(connectionIssue(definition, "check", "other", "false"), undefined);
  assert.match(connectionIssue(definition, "check", "other", "true") ?? "", /已有连线/);
  assert.match(connectionIssue(definition, "check", "end", "false") ?? "", /汇合/);
  assert.match(connectionIssue(definition, "check", "check", "false") ?? "", /自身/);
  assert.match(connectionIssue(definition, "check", "start", "false") ?? "", /开始节点/);
  assert.match(connectionIssue(definition, "end", "other", "out") ?? "", /结束节点/);
  assert.match(connectionIssue(definition, "check", "other", "out") ?? "", /端口/);
  definition.nodes.push({ id: "map", type: "map", label: "映射", values: {} });
  definition.edges = [{ source: "check", target: "map", port: "true" }];
  assert.match(connectionIssue(definition, "map", "check", "out") ?? "", /循环/);
});
