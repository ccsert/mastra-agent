import {
  ASTKind,
  type ASTNodeJSON,
  type BaseVariableField,
  FlowNodeVariableData,
  type FreeLayoutPluginContext,
  ObjectType,
  type VariableDeclarationJSON,
} from "@flowgram.ai/free-layout-editor";
import type { WorkflowCapability, WorkflowDefinition } from "@platform/sdk";
import { objectSchema } from "./workflow-model";

export interface WorkflowVariableOption {
  label: string;
  value: string;
  type: string;
  optional: boolean;
}

// JSON Schema remains the publishing contract. The AST is the editor's scoped view.
function schemaType(schema: Record<string, unknown>, depth = 0): ASTNodeJSON {
  if (depth > 20) return { kind: ASTKind.Any };
  if (schema.type === "object")
    return {
      kind: ASTKind.Object,
      properties: Object.entries(objectSchema(schema.properties)).map(([key, value]) => ({
        key,
        type: schemaType(objectSchema(value), depth + 1),
        meta: { optional: !Array.isArray(schema.required) || !schema.required.includes(key) },
      })),
    };
  if (schema.type === "array")
    return { kind: ASTKind.Array, items: schemaType(objectSchema(schema.items), depth + 1) };
  const kinds: Record<string, ASTKind> = {
    string: ASTKind.String,
    integer: ASTKind.Integer,
    number: ASTKind.Number,
    boolean: ASTKind.Boolean,
  };
  return { kind: kinds[String(schema.type)] ?? ASTKind.Any };
}

function literalType(value: unknown, depth = 0): ASTNodeJSON {
  if (depth > 20 || value === null) return { kind: ASTKind.Any };
  if (Array.isArray(value)) return { kind: ASTKind.Array, items: { kind: ASTKind.Any } };
  if (typeof value === "object")
    return {
      kind: ASTKind.Object,
      properties: Object.entries(value).map(([key, item]) => ({
        key,
        type: literalType(item, depth + 1),
      })),
    };
  return schemaType({ type: typeof value });
}

export function syncWorkflowVariables(
  ctx: FreeLayoutPluginContext,
  definition: WorkflowDefinition,
  catalog: WorkflowCapability[],
) {
  for (const node of definition.nodes) {
    const entity = ctx.document.getNode(node.id);
    if (!entity) continue;
    const data = entity.getData(FlowNodeVariableData);
    const entry = catalog.find(
      (c) =>
        (node.type === "tool" && c.kind === "tool" && c.id === node.toolId) ||
        (node.type === "agent" && c.kind === "agent" && c.id === node.releaseId),
    );
    const schema =
      node.type === "start"
        ? definition.inputSchema
        : (entry?.outputSchema ??
          (node.type === "condition"
            ? {
                type: "object",
                properties: { matched: { type: "boolean" } },
                required: ["matched"],
              }
            : undefined));
    if (!schema && node.type !== "map") {
      data.clearVar();
      continue;
    }
    const declaration: VariableDeclarationJSON = {
      kind: ASTKind.VariableDeclaration,
      key: node.id,
      meta: { label: node.label, path: node.type === "start" ? "input" : `nodes.${node.id}` },
      type: schemaType(schema ?? {}),
    };
    if (node.type === "map") {
      declaration.type = {
        kind: ASTKind.Object,
        properties: Object.entries(node.values).map(([key, binding]) => {
          if (binding.kind === "ref") {
            const parts = binding.path.split(".");
            const keyPath =
              parts[0] === "input"
                ? [
                    definition.nodes.find((n) => n.type === "start")?.id ?? "start",
                    ...parts.slice(1),
                  ]
                : parts.slice(1);
            return { key, initializer: { kind: ASTKind.KeyPathExpression, keyPath } };
          }
          return {
            key,
            type:
              binding.kind === "template" ? { kind: ASTKind.String } : literalType(binding.value),
          };
        }),
      };
    }
    // setVar updates existing declarations and their dependent scopes in place.
    data.setVar(declaration);
  }
}

export function workflowVariableIssue(
  ctx: FreeLayoutPluginContext,
  nodeId: string,
  path: string,
  allowOptional = false,
) {
  const parts = path.split(".");
  const scope = ctx.document.getNode(nodeId)?.getData(FlowNodeVariableData).public;
  const prefix = parts[0] === "input" ? "input" : parts.slice(0, 2).join(".");
  const root = scope?.available.variables.find((variable) => variable.meta?.path === prefix);
  if (!root) return `引用不可用：${path}。请连接到提供变量的上游节点`;
  let field: BaseVariableField | undefined = root;
  for (const key of parts.slice(prefix === "input" ? 1 : 2)) {
    field = field?.getByKeyPath([key]);
    if (!field) return `引用字段不存在：${path}`;
    if (field.meta?.optional && !allowOptional) return `变量 ${path} 可能为空，请先判断是否存在`;
  }
  return undefined;
}

export function scopedWorkflowVariables(ctx: FreeLayoutPluginContext, nodeId: string) {
  const scope = ctx.document.getNode(nodeId)?.getData(FlowNodeVariableData).public;
  const options: WorkflowVariableOption[] = [];
  const walk = (
    field: BaseVariableField,
    path: string,
    label: string,
    optional = false,
    depth = 0,
  ) => {
    if (depth > 5 || options.length >= 200) return;
    const maybeMissing = optional || field.meta?.optional === true;
    // A KeyPathExpression can be unresolved while its upstream node is disconnected.
    const fieldType = field.type;
    const type =
      !fieldType || fieldType.kind === ASTKind.Any ? "未知" : fieldType.kind.toLowerCase();
    options.push({
      value: path,
      label: `${label} · ${type}${maybeMissing ? "（可能为空）" : ""}`,
      type,
      optional: maybeMissing,
    });
    if (fieldType instanceof ObjectType)
      for (const child of fieldType.properties)
        walk(child, `${path}.${child.key}`, `${label}.${child.key}`, maybeMissing, depth + 1);
  };
  for (const field of scope?.available.variables ?? []) {
    if (typeof field.meta?.path === "string")
      walk(field, field.meta.path, String(field.meta.label));
  }
  return options;
}
