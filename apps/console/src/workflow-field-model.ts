import type { WorkflowBinding, WorkflowNode } from "@platform/sdk";
import type { WorkflowVariableOption } from "./workflow-variables";

export const valueTypes = [
  { value: "string", label: "文本" },
  { value: "number", label: "数值" },
  { value: "boolean", label: "布尔值" },
  { value: "object", label: "对象" },
  { value: "array", label: "数组" },
  { value: "null", label: "空值" },
];
export const conditionOperators = [
  { value: "eq", label: "等于", symbol: "=" },
  { value: "neq", label: "不等于", symbol: "≠" },
  { value: "exists", label: "有值（非 null）", symbol: "∃" },
  { value: "gt", label: "大于", symbol: ">" },
  { value: "gte", label: "大于或等于", symbol: "≥" },
  { value: "lt", label: "小于", symbol: "<" },
  { value: "lte", label: "小于或等于", symbol: "≤" },
];
export const numericOperators = ["gt", "gte", "lt", "lte"];
export function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
export function bindingType(
  binding: WorkflowBinding | undefined,
  options: WorkflowVariableOption[],
) {
  const type =
    binding?.kind === "literal"
      ? valueType(binding.value)
      : binding?.kind === "template"
        ? "string"
        : options.find((v) => v.value === binding?.path)?.type;
  return type === "integer" ? "number" : type;
}
export function defaultLiteral(type?: string): unknown {
  return type === "number" || type === "integer"
    ? 0
    : type === "boolean"
      ? true
      : type === "object"
        ? {}
        : type === "array"
          ? []
          : type === "null"
            ? null
            : "";
}
export function variableName(path: string, options: WorkflowVariableOption[]) {
  return options.find((v) => v.value === path)?.label.split(" · ")[0] ?? path;
}
export function describeBinding(
  value: WorkflowBinding | undefined,
  options: WorkflowVariableOption[],
) {
  if (!value) return "未设置";
  if (value.kind === "ref") return variableName(value.path, options);
  if (value.kind === "template") return "文本模板";
  return JSON.stringify(value.value);
}
export function conditionTypeIssue(
  node: Extract<WorkflowNode, { type: "condition" }>,
  options: WorkflowVariableOption[],
) {
  if (node.operator === "exists") return undefined;
  if (!node.right) return "请设置比较值。";
  const left = bindingType(node.left, options),
    right = bindingType(node.right, options);
  if (numericOperators.includes(node.operator)) {
    if (left !== "number" || right !== "number")
      return "大小比较要求两侧都是数值，请选择数值变量或输入数值。";
  } else if (left && right && !["未知", "any"].includes(left) && !["未知", "any"].includes(right)) {
    if (!["string", "number", "boolean", "null"].includes(left))
      return "对象和数组请使用“有值”判断，或选择其中的具体字段进行比较。";
    if (left !== right) return "两侧类型必须一致，例如文本与文本、数值与数值。";
  }
  return undefined;
}

/** Template tokens preserve the platform DSL; never translate them to the demo's Jinja syntax. */
export function promptVariables(text: string) {
  return [...new Set([...text.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]))];
}
