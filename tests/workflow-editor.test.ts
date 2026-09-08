import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionIssue,
  emptyWorkflow,
  needsWorkflowLayout,
} from "../apps/console/src/workflow-model.ts";

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

test("line insertion preserves branch topology and leaves geometry to the editor without partial mutation", async () => {
  const { insertWorkflowNode } = await import("../apps/console/src/workflow-editing.ts");
  const original = emptyWorkflow("插入");
  original.layout = { start: { x: 0, y: 0 }, end: { x: 380, y: 0 } };
  let id = 0;
  const { next, id: condition } = insertWorkflowNode(
    original,
    "condition",
    { position: { x: 380, y: 0 }, source: "start", port: "out", target: "end" },
    [],
    () => String(++id),
  );
  assert.equal(original.definition.nodes.length, 2);
  assert.deepEqual(original.layout.end, { x: 380, y: 0 });
  assert.equal(next.definition.nodes.length, 4);
  assert.ok(next.definition.edges.some((e) => e.source === condition && e.port === "false"));
  const falseEdge = next.definition.edges.find((e) => e.source === condition && e.port === "false");
  assert.ok(falseEdge);
  assert.deepEqual(next.layout?.end, original.layout.end);
  assert.equal(next.layout?.[falseEdge.target], undefined);
  assert.equal(needsWorkflowLayout(next), true);
  const truePosition = structuredClone(next.layout?.end);
  const inserted = insertWorkflowNode(
    next,
    "map",
    { position: { x: 760, y: 280 }, source: condition, port: "false", target: falseEdge.target },
    [],
    () => String(++id),
  );
  assert.ok(
    inserted.next.definition.edges.some(
      (e) => e.source === condition && e.target === inserted.id && e.port === "false",
    ),
  );
  assert.deepEqual(inserted.next.layout?.end, truePosition);
  assert.throws(
    () =>
      insertWorkflowNode(
        next,
        "end",
        { position: { x: 0, y: 0 }, source: condition, port: "false", target: falseEdge.target },
        [],
      ),
    /结束节点不能/,
  );
  assert.throws(
    () =>
      insertWorkflowNode(
        next,
        "map",
        { position: { x: 0, y: 0 }, source: condition, port: "false", target: "missing" },
        [],
      ),
    /连线已改变/,
  );
});

test("pasting selected nodes rewrites internal references while preserving literals and external references", async () => {
  const { pasteWorkflowNodes } = await import("../apps/console/src/workflow-editing.ts");
  const current = emptyWorkflow("粘贴"),
    copied = emptyWorkflow("剪贴板");
  copied.definition.nodes = [
    {
      id: "a",
      type: "map",
      label: "映射A",
      values: { input: { kind: "ref", path: "input.task" } },
    },
    {
      id: "b",
      type: "map",
      label: "映射B",
      values: {
        ref: { kind: "ref", path: "nodes.a.input" },
        template: { kind: "template", template: `\${nodes.a.input} / \${nodes.external.value}` },
        literal: { kind: "literal", value: "nodes.a.input" },
      },
    },
  ];
  copied.definition.edges = [{ source: "a", target: "b", port: "out" }];
  const { next, ids } = pasteWorkflowNodes(current, copied);
  assert.equal(next.definition.nodes.length, 4);
  const b = next.definition.nodes.find((n) => n.id === ids[1]);
  assert.equal(b?.type, "map");
  if (b?.type !== "map") throw new Error("missing pasted node");
  assert.deepEqual(b.values.ref, { kind: "ref", path: `nodes.${ids[0]}.input` });
  assert.deepEqual(b.values.template, {
    kind: "template",
    template: `\${nodes.${ids[0]}.input} / \${nodes.external.value}`,
  });
  assert.deepEqual(b.values.literal, { kind: "literal", value: "nodes.a.input" });
  assert.deepEqual(next.definition.edges.at(-1), { source: ids[0], target: ids[1], port: "out" });
});
