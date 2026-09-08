import type {
  WorkflowAssetInput,
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowNode,
} from "@platform/sdk";

export const nodeNames: Record<WorkflowNode["type"], string> = {
  start: "开始",
  end: "结束",
  tool: "业务工具",
  agent: "Agent",
  map: "变量映射",
  condition: "条件分支",
};
export function emptyWorkflow(name: string): WorkflowAssetInput {
  return {
    name,
    description: "",
    layout: {},
    definition: {
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { report: { type: "string" } },
        required: ["report"],
        additionalProperties: false,
      },
      nodes: [
        { id: "start", type: "start", label: "任务输入" },
        {
          id: "end",
          type: "end",
          label: "结果输出",
          values: { report: { kind: "ref", path: "input.task" } },
        },
      ],
      edges: [{ source: "start", target: "end", port: "out" }],
    },
  };
}
export function autoPositions(definition: WorkflowDefinition) {
  const positions: Record<string, { x: number; y: number }> = {},
    visited = new Set<string>();
  let lane = 0;
  const walk = (id: string, depth: number, y: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    positions[id] = { x: depth * 290 + 50, y: y * 175 + 90 };
    const edges = definition.edges
      .filter((e) => e.source === id)
      .sort((a, b) => b.port.localeCompare(a.port));
    edges.forEach((edge, i) => {
      walk(edge.target, depth + 1, i ? ++lane : y);
    });
  };
  const start = definition.nodes.find((n) => n.type === "start");
  if (start) walk(start.id, 0, 0);
  definition.nodes.forEach((n) => {
    if (!positions[n.id]) positions[n.id] = { x: 50, y: ++lane * 175 + 90 };
  });
  return positions;
}
export const objectSchema = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function connectionIssue(
  definition: WorkflowDefinition,
  source: string,
  target: string,
  port: string,
) {
  const from = definition.nodes.find((n) => n.id === source);
  const to = definition.nodes.find((n) => n.id === target);
  if (!from || !to || source === target) return "不能连接到自身或不存在的节点";
  if (from.type === "end" || to.type === "start")
    return "开始节点不能接收入线，结束节点不能引出连线";
  if (!(from.type === "condition" ? ["true", "false"] : ["out"]).includes(port))
    return "连线端口不匹配";
  if (definition.edges.some((e) => e.source === source && e.port === port))
    return "此出口已有连线，请先删除原连线";
  if (definition.edges.some((e) => e.target === target))
    return "当前执行器尚不支持路径汇合，请连接到独立分支";
  const pending = [target],
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    if (id === source) return "这条连线会形成循环，当前流程不支持循环";
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...definition.edges.filter((e) => e.source === id).map((e) => e.target));
  }
  return undefined;
}
export function bindingText(binding: WorkflowBinding) {
  return binding.kind === "ref"
    ? binding.path
    : binding.kind === "template"
      ? binding.template
      : typeof binding.value === "string"
        ? binding.value
        : JSON.stringify(binding.value);
}
export function describeChanges(before: WorkflowDefinition, after: WorkflowDefinition) {
  const lines: string[] = [];
  for (const node of before.nodes)
    if (!after.nodes.some((n) => n.id === node.id)) lines.push(`删除「${node.label}」`);
  for (const node of after.nodes) {
    const previous = before.nodes.find((n) => n.id === node.id);
    if (!previous) lines.push(`新增「${node.label}」· ${nodeNames[node.type]}`);
    else if (JSON.stringify(previous) !== JSON.stringify(node))
      lines.push(`修改「${node.label}」的配置或资源绑定`);
  }
  if (JSON.stringify(before.edges) !== JSON.stringify(after.edges))
    lines.push("调整节点连线与执行路径");
  if (JSON.stringify(before.inputSchema) !== JSON.stringify(after.inputSchema))
    lines.push("修改流程输入契约");
  if (JSON.stringify(before.outputSchema) !== JSON.stringify(after.outputSchema))
    lines.push("修改流程输出契约");
  return lines.length ? lines : ["候选与当前流程没有变化"];
}
