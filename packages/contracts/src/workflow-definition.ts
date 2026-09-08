import { z } from "@hono/zod-openapi";
import { canonicalJson, compileMcpSchema } from "./mcp-profile.ts";

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)
  .refine((s) => !["constructor", "prototype"].includes(s));
const schema = z.record(z.string(), z.unknown());
export const WorkflowBinding = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: z.unknown() }).strict(),
    z.object({ kind: z.literal("ref"), path: z.string().min(1).max(200) }).strict(),
    z.object({ kind: z.literal("template"), template: z.string().max(16000) }).strict(),
  ])
  .openapi("WorkflowBinding");
export type WorkflowBinding = z.infer<typeof WorkflowBinding>;
const fieldKey = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/)
  .refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
const values = z.record(fieldKey, WorkflowBinding);
const base = z.object({ id: key, label: z.string().trim().min(1).max(80) });
export const WorkflowNode = z
  .discriminatedUnion("type", [
    base.extend({ type: z.literal("start") }).strict(),
    base.extend({ type: z.literal("end"), values }).strict(),
    base.extend({ type: z.literal("map"), values }).strict(),
    base.extend({ type: z.literal("tool"), toolId: z.uuid(), input: values }).strict(),
    base
      .extend({ type: z.literal("agent"), releaseId: z.uuid(), prompt: WorkflowBinding })
      .strict(),
    base
      .extend({
        type: z.literal("condition"),
        left: WorkflowBinding,
        operator: z.enum(["eq", "neq", "exists", "gt", "gte", "lt", "lte"]),
        right: WorkflowBinding.optional(),
      })
      .strict(),
  ])
  .openapi("WorkflowNode");
export type WorkflowNode = z.infer<typeof WorkflowNode>;
export const WorkflowDefinition = z
  .object({
    inputSchema: schema,
    outputSchema: schema,
    nodes: z.array(WorkflowNode).min(2).max(24),
    edges: z
      .array(
        z.object({ source: key, target: key, port: z.enum(["out", "true", "false"]) }).strict(),
      )
      .min(1)
      .max(23),
  })
  .strict()
  .openapi("WorkflowDefinition");
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
export const WorkflowLayout = z
  .record(
    key,
    z
      .object({ x: z.number().min(-100000).max(100000), y: z.number().min(-100000).max(100000) })
      .strict(),
  )
  .openapi("WorkflowLayout");
export const WorkflowAssetInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    definition: WorkflowDefinition,
    layout: WorkflowLayout.default({}),
  })
  .strict()
  .openapi("WorkflowAssetInput");
export const WorkflowIssue = z
  .object({
    code: z.string(),
    message: z.string(),
    nodeId: z.string().optional(),
    field: z.string().optional(),
  })
  .openapi("WorkflowIssue");
export type WorkflowIssue = z.infer<typeof WorkflowIssue>;
export const WorkflowCapability = z
  .object({
    id: z.uuid(),
    kind: z.enum(["tool", "agent"]),
    name: z.string(),
    description: z.string(),
    version: z.number().int(),
    inputSchema: schema,
    outputSchema: schema,
  })
  .openapi("WorkflowCapability");
export type WorkflowCapability = z.infer<typeof WorkflowCapability>;

type Shape = Record<string, unknown>;
export const agentWorkflowOutput: Shape = {
  type: "object",
  properties: { text: { type: "string" }, sources: { type: "array", items: { type: "object" } } },
  required: ["text", "sources"],
  additionalProperties: false,
};
export const agentWorkflowInput: Shape = {
  type: "object",
  properties: { prompt: { type: "string", minLength: 1, maxLength: 16000 } },
  required: ["prompt"],
  additionalProperties: false,
};
class InvalidWorkflow extends Error {
  constructor(readonly issue: WorkflowIssue) {
    super(issue.message);
  }
}
function invalid(code: string, message: string, nodeId?: string, field?: string): never {
  throw new InvalidWorkflow({ code, message, nodeId, field });
}
function object(value: unknown): Shape {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Shape) : {};
}
function jsonBudget(value: unknown, limit = 64000) {
  let count = 0;
  const visit = (v: unknown, depth: number) => {
    if (++count > 5000 || depth > 20) throw new Error("WORKFLOW_VALUE_LIMIT");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (!v || typeof v !== "object") throw new Error("WORKFLOW_VALUE_INVALID");
    for (const [k, item] of Object.entries(v)) {
      if (["__proto__", "prototype", "constructor"].includes(k))
        throw new Error("WORKFLOW_VALUE_INVALID");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (JSON.stringify(value).length > limit) throw new Error("WORKFLOW_VALUE_LIMIT");
}
export function assertWorkflowValue(shape: Shape, value: unknown) {
  jsonBudget(value);
  const validate = compileMcpSchema({
    type: "object",
    properties: { value: shape },
    required: ["value"],
    additionalProperties: false,
  });
  if (!validate({ value })) throw new Error("WORKFLOW_VALUE_INVALID");
}
function literalShape(value: unknown): Shape {
  jsonBudget(value, 16000);
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: commonLiteralShape(value.map(literalShape)),
      ...(value.length === 0 ? { maxItems: 0 } : {}),
    };
  }
  if (typeof value === "object")
    return recordShape(
      Object.fromEntries(Object.entries(object(value)).map(([k, v]) => [k, literalShape(v)])),
    );
  return { type: Number.isInteger(value) ? "integer" : typeof value };
}
function commonLiteralShape(shapes: Shape[]): Shape {
  if (!shapes.length) return {};
  if (shapes.every((s) => s.type === "integer" || s.type === "number"))
    return { type: shapes.some((s) => s.type === "number") ? "number" : "integer" };
  const type = shapes[0].type;
  if (!type || shapes.some((s) => s.type !== type)) return {};
  if (type === "object") {
    const keys = [...new Set(shapes.flatMap((s) => Object.keys(object(s.properties))))].sort();
    return {
      type,
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          commonLiteralShape(
            shapes
              .filter((s) => Object.hasOwn(object(s.properties), key))
              .map((s) => object(object(s.properties)[key])),
          ),
        ]),
      ),
      required: keys.filter((key) =>
        shapes.every((s) => Array.isArray(s.required) && s.required.includes(key)),
      ),
      additionalProperties: false,
    };
  }
  if (type === "array") {
    const nonempty = shapes.filter((s) => s.maxItems !== 0);
    return {
      type,
      items: commonLiteralShape(nonempty.map((s) => object(s.items))),
      ...(nonempty.length ? {} : { maxItems: 0 }),
    };
  }
  return { type };
}
const recordShape = (properties: Record<string, Shape>): Shape => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
function pathParts(path: string) {
  if (
    !/^(input|nodes\.[a-z][a-z0-9_]{0,39})(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(path) ||
    path.split(".").some((p) => ["__proto__", "constructor", "prototype"].includes(p))
  )
    invalid("INVALID_REFERENCE", "变量引用格式无效");
  return path.split(".");
}
function refShape(path: string, input: Shape, prior: Map<string, Shape>, optional = false): Shape {
  const parts = pathParts(path);
  let current = parts.shift() === "input" ? input : prior.get(parts.shift() ?? "");
  if (!current) invalid("UNKNOWN_REFERENCE", "只能引用当前路径中上游节点的输出");
  for (const part of parts) {
    const properties = object(current.properties);
    if (current.type !== "object" || !Object.hasOwn(properties, part))
      invalid("UNKNOWN_REFERENCE", `变量字段不存在：${path}`);
    if (!optional && !(Array.isArray(current.required) && current.required.includes(part)))
      invalid("OPTIONAL_REFERENCE", `变量可能不存在：${path}；先使用明确的必填输出`);
    current = object(properties[part]);
  }
  return current;
}
function templatePaths(template: string) {
  const paths = [...template.matchAll(/\$\{([^{}]+)\}/g)].map((m) => m[1]);
  if (template.replace(/\$\{[^{}]+\}/g, "").includes("${"))
    invalid("INVALID_TEMPLATE", `模板变量必须使用 \${input.field} 或 \${nodes.id.field}`);
  return paths;
}
function bindingShape(
  binding: WorkflowBinding,
  input: Shape,
  prior: Map<string, Shape>,
  optional = false,
): Shape {
  if (binding.kind === "literal") return literalShape(binding.value);
  if (binding.kind === "ref") return refShape(binding.path, input, prior, optional);
  for (const path of templatePaths(binding.template)) refShape(path, input, prior);
  return { type: "string" };
}
function compatible(from: Shape, to: Shape) {
  if (!to.type) invalid("UNKNOWN_TYPE", "此接口的字段类型未明确，需先完善 Schema");
  if (from.type !== to.type && !(from.type === "integer" && to.type === "number"))
    invalid("TYPE_MISMATCH", `变量类型 ${String(from.type)} 与目标 ${String(to.type)} 不兼容`);
  if (to.type === "object") {
    const a = object(from.properties),
      b = object(to.properties);
    for (const required of Array.isArray(to.required) ? to.required : [])
      if (!(Array.isArray(from.required) && from.required.includes(required)))
        invalid("MISSING_INPUT", `缺少必填字段：${required}`);
    for (const [key, value] of Object.entries(a)) {
      if (Object.hasOwn(b, key)) compatible(object(value), object(b[key]));
      else if (to.additionalProperties === false) invalid("EXTRA_INPUT", `接口没有字段：${key}`);
    }
  }
  if (to.type === "array" && object(to.items).type && from.maxItems !== 0)
    compatible(object(from.items), object(to.items));
}
export function validateWorkflow(
  definition: WorkflowDefinition,
  catalog: WorkflowCapability[],
): WorkflowIssue[] {
  let at: string | undefined;
  try {
    jsonBudget(definition, 96000);
    for (const s of [definition.inputSchema, definition.outputSchema]) {
      if (s.type !== "object") invalid("SCHEMA_INVALID", "流程输入输出必须为 object Schema");
      compileMcpSchema(s);
    }
    const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    if (nodes.size !== definition.nodes.length) invalid("DUPLICATE_NODE", "节点 ID 不能重复");
    const starts = definition.nodes.filter((n) => n.type === "start");
    if (starts.length !== 1) invalid("START_REQUIRED", "流程必须有且只有一个开始节点");
    for (const edge of definition.edges)
      if (!nodes.has(edge.source) || !nodes.has(edge.target))
        invalid("UNKNOWN_EDGE", "连线引用不存在的节点");
    for (const node of definition.nodes) {
      const incoming = definition.edges.filter((e) => e.target === node.id),
        outgoing = definition.edges.filter((e) => e.source === node.id);
      if (incoming.length !== (node.type === "start" ? 0 : 1))
        invalid(
          "GRAPH_STRUCTURE",
          "当前支持独立结束的分支路径，每个后续节点只能有一个前驱",
          node.id,
        );
      const ports = outgoing
        .map((e) => e.port)
        .sort()
        .join(",");
      if (ports !== (node.type === "end" ? "" : node.type === "condition" ? "false,true" : "out"))
        invalid(
          "GRAPH_PORTS",
          "普通节点需一条输出，条件需满足/不满足各一条输出，结束节点不能连出",
          node.id,
        );
    }
    const seen = new Set<string>();
    const visit = (id: string, prior: Map<string, Shape>, depth: number) => {
      at = id;
      if (seen.has(id) || depth > 24) invalid("GRAPH_CYCLE", "流程不能包含循环或重复汇合");
      seen.add(id);
      const node = nodes.get(id);
      if (!node) return invalid("MISSING_NODE", "连线引用了不存在的节点");
      let output: Shape = definition.inputSchema;
      const mapped = (bindings: Record<string, WorkflowBinding>, target?: Shape) => {
        const result = recordShape(
          Object.fromEntries(
            Object.entries(bindings).map(([k, v]) => [
              k,
              bindingShape(v, definition.inputSchema, prior),
            ]),
          ),
        );
        if (target) {
          compatible(result, target);
          for (const [key, b] of Object.entries(bindings))
            if (b.kind === "literal" && Object.hasOwn(object(target.properties), key))
              assertWorkflowValue(object(object(target.properties)[key]), b.value);
        }
        return result;
      };
      if (node.type === "tool" || node.type === "agent") {
        const entry = catalog.find(
          (c) =>
            c.kind === node.type && c.id === (node.type === "tool" ? node.toolId : node.releaseId),
        );
        if (!entry) invalid("DEPENDENCY_UNAVAILABLE", "节点引用的工具或 Agent 发布不可用");
        mapped(node.type === "tool" ? node.input : { prompt: node.prompt }, entry.inputSchema);
        output = entry.outputSchema;
      } else if (node.type === "map") output = mapped(node.values);
      else if (node.type === "end") output = mapped(node.values, definition.outputSchema);
      else if (node.type === "condition") {
        const left = bindingShape(
          node.left,
          definition.inputSchema,
          prior,
          node.operator === "exists",
        );
        if (node.operator === "exists") {
          if (node.right) invalid("CONDITION_INVALID", "存在性判断不需要比较值");
        } else {
          if (!node.right) invalid("CONDITION_INVALID", "条件缺少比较值");
          const right = bindingShape(node.right, definition.inputSchema, prior);
          if (["gt", "gte", "lt", "lte"].includes(node.operator)) {
            if (
              !["number", "integer"].includes(String(left.type)) ||
              !["number", "integer"].includes(String(right.type))
            )
              invalid("CONDITION_TYPE", "大小比较只支持数值");
          } else if (
            !["string", "number", "integer", "boolean", "null"].includes(String(left.type))
          )
            invalid("CONDITION_TYPE", "相等判断只支持基本类型");
          else if (
            left.type !== right.type &&
            !(
              ["number", "integer"].includes(String(left.type)) &&
              ["number", "integer"].includes(String(right.type))
            )
          )
            invalid("CONDITION_TYPE", "条件两侧的类型不一致");
        }
        output = {
          type: "object",
          properties: { matched: { type: "boolean" } },
          required: ["matched"],
          additionalProperties: false,
        };
      }
      const next = new Map(prior).set(id, output);
      for (const edge of definition.edges.filter((e) => e.source === id))
        visit(edge.target, next, depth + 1);
    };
    visit(starts[0].id, new Map(), 0);
    if (seen.size !== nodes.size) invalid("DISCONNECTED_GRAPH", "所有节点都必须从开始节点可达");
    return [];
  } catch (error) {
    if (error instanceof InvalidWorkflow)
      return [{ ...error.issue, nodeId: error.issue.nodeId ?? at }];
    return [
      {
        code: "SCHEMA_OR_VALUE_INVALID",
        message: "Schema、常量或定义大小不符合流程约束",
        nodeId: at,
      },
    ];
  }
}
export function resolveBinding(
  binding: WorkflowBinding,
  input: unknown,
  outputs: Record<string, unknown>,
  optional = false,
): unknown {
  const read = (path: string) => {
    const parts = pathParts(path);
    let value = parts.shift() === "input" ? input : outputs[parts.shift() ?? ""];
    for (const p of parts)
      value =
        value && typeof value === "object" && Object.hasOwn(value, p)
          ? object(value)[p]
          : undefined;
    if (value === undefined && !optional) throw new Error("WORKFLOW_REFERENCE_MISSING");
    return value;
  };
  if (binding.kind === "literal") return structuredClone(binding.value);
  if (binding.kind === "ref") return read(binding.path);
  templatePaths(binding.template);
  const value = binding.template.replace(/\$\{([^{}]+)\}/g, (_, path) => {
    const v = read(path);
    return typeof v === "string" ? v : canonicalJson(v);
  });
  if (value.length > 16000) throw new Error("WORKFLOW_VALUE_LIMIT");
  return value;
}
export function resolveMappings(
  bindings: Record<string, WorkflowBinding>,
  input: unknown,
  outputs: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.entries(bindings).map(([k, v]) => [k, resolveBinding(v, input, outputs)]),
  );
}
export function evaluateCondition(
  node: Extract<WorkflowNode, { type: "condition" }>,
  input: unknown,
  outputs: Record<string, unknown>,
) {
  const left = resolveBinding(node.left, input, outputs, node.operator === "exists");
  if (node.operator === "exists") return left !== undefined && left !== null;
  const right = node.right ? resolveBinding(node.right, input, outputs) : undefined;
  if (node.operator === "eq") return left === right;
  if (node.operator === "neq") return left !== right;
  if (typeof left !== "number" || typeof right !== "number")
    throw new Error("WORKFLOW_VALUE_INVALID");
  return node.operator === "gt"
    ? left > right
    : node.operator === "gte"
      ? left >= right
      : node.operator === "lt"
        ? left < right
        : left <= right;
}
export function workflowNodeInput(
  node: WorkflowNode,
  input: unknown,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  if (node.type === "start") return object(input);
  if (node.type === "tool") return resolveMappings(node.input, input, outputs);
  if (node.type === "agent") return { prompt: resolveBinding(node.prompt, input, outputs) };
  if (node.type === "map" || node.type === "end")
    return resolveMappings(node.values, input, outputs);
  return {
    left: resolveBinding(node.left, input, outputs, node.operator === "exists") ?? null,
    ...(node.right ? { right: resolveBinding(node.right, input, outputs) } : {}),
  };
}
export function workflowExecutionDefinition(definition: WorkflowDefinition) {
  return {
    ...definition,
    nodes: definition.nodes
      .map(({ label: _label, ...n }) => n)
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...definition.edges].sort((a, b) =>
      `${a.source}/${a.port}`.localeCompare(`${b.source}/${b.port}`),
    ),
  };
}

export function validateWorkflowProposal(
  definition: WorkflowDefinition,
  base: WorkflowDefinition,
  catalog: WorkflowCapability[],
): WorkflowIssue[] {
  const issues = validateWorkflow(definition, catalog);
  if (issues.length) return issues;
  const ordered = (value: WorkflowDefinition) => ({
    ...value,
    nodes: [...value.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: workflowExecutionDefinition(value).edges,
  });
  if (canonicalJson(ordered(definition)) === canonicalJson(ordered(base)))
    return [
      {
        code: "NO_CHANGES",
        message: "候选没有修改当前流程。请落实用户本次要求；若能力不足，请明确说明，不能原样提交。",
      },
    ];
  return [];
}
