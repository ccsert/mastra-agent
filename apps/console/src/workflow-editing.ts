import type { WorkflowAssetInput, WorkflowCapability, WorkflowNode } from "@platform/sdk";
import { nodeNames, objectSchema } from "./workflow-model";

export type AddableNodeType = Exclude<WorkflowNode["type"], "start">;
export interface NodePlacement {
  position: { x: number; y: number };
  source?: string;
  port?: "out" | "true" | "false";
  target?: string;
}

/** The panel chooses a material; the platform commits one executable graph edit. */
export function insertWorkflowNode(
  current: WorkflowAssetInput,
  type: AddableNodeType,
  placement: NodePlacement,
  catalog: WorkflowCapability[],
  newId: () => string = () => crypto.randomUUID().slice(0, 8),
) {
  const next = structuredClone(current);
  const { definition } = next;
  const edge = placement.source
    ? definition.edges.find((e) => e.source === placement.source && e.port === placement.port)
    : undefined;
  if (placement.target && edge?.target !== placement.target)
    throw new Error("这条连线已改变，请重新选择插入位置");
  if (edge && type === "end") throw new Error("结束节点不能插在两个步骤之间");
  if (placement.source) {
    const source = definition.nodes.find((n) => n.id === placement.source);
    if (
      !source ||
      source.type === "end" ||
      !(source.type === "condition" ? ["true", "false"] : ["out"]).includes(placement.port ?? "")
    )
      throw new Error("添加位置已不可用，请重新选择端口");
  }
  const extraEnd = type === "condition" && !!edge;
  if (definition.nodes.length + (extraEnd ? 2 : 1) > 24) throw new Error("当前流程最多 24 个节点");
  const entry = catalog.find((c) => c.kind === type);
  if ((type === "tool" || type === "agent") && !entry)
    throw new Error(type === "agent" ? "请先发布一个 Agent" : "请先登记可用的业务工具");
  const outputValues = Object.fromEntries(
    Object.entries(objectSchema(definition.outputSchema.properties)).map(([key, schema]) => {
      const t = objectSchema(schema).type;
      return [
        key,
        {
          kind: "literal" as const,
          value:
            t === "string"
              ? ""
              : t === "boolean"
                ? false
                : t === "array"
                  ? []
                  : t === "object"
                    ? {}
                    : 0,
        },
      ];
    }),
  );
  const id = `${type}_${newId()}`;
  const node: WorkflowNode =
    type === "tool"
      ? { id, type, label: entry?.name ?? "业务工具", toolId: entry?.id ?? "", input: {} }
      : type === "agent"
        ? {
            id,
            type,
            label: entry?.name ?? "Agent 处理",
            releaseId: entry?.id ?? "",
            prompt: { kind: "template", template: `处理以下输入：\${input}` },
          }
        : type === "condition"
          ? {
              id,
              type,
              label: "条件判断",
              left: { kind: "literal", value: true },
              operator: "eq",
              right: { kind: "literal", value: true },
            }
          : {
              id,
              type,
              label: nodeNames[type],
              values: type === "end" ? outputValues : { value: { kind: "ref", path: "input" } },
            };
  definition.nodes.push(node);
  next.layout = {
    ...next.layout,
    [id]: { ...placement.position },
  };
  if (placement.source && placement.port) {
    if (edge) definition.edges = definition.edges.filter((e) => e !== edge);
    definition.edges.push({ source: placement.source, target: id, port: placement.port });
    if (edge) {
      definition.edges.push({
        source: id,
        target: edge.target,
        port: type === "condition" ? "true" : "out",
      });
    }
  }
  if (extraEnd) {
    const endId = `end_${newId()}`;
    definition.nodes.push({ id: endId, type: "end", label: "不满足时返回", values: outputValues });
    definition.edges.push({ source: id, target: endId, port: "false" });
    // Missing geometry is laid out by FlowGram after the nodes have rendered.
  }
  return { next, id };
}

export function pasteWorkflowNodes(
  current: WorkflowAssetInput,
  copied: WorkflowAssetInput,
  offset = 48,
) {
  const nodes = copied.definition.nodes.filter((n) => n.type !== "start");
  if (current.definition.nodes.length + nodes.length > 24)
    throw new Error("当前流程最多 24 个节点");
  const ids = Object.fromEntries(
    nodes.map((n) => [n.id, `${n.type}_${crypto.randomUUID().slice(0, 8)}`]),
  );
  const remapPath = (path: string) =>
    path.replace(/^nodes\.([^.]+)/, (prefix, id: string) =>
      ids[id] ? `nodes.${ids[id]}` : prefix,
    );
  const remap = (
    binding: import("@platform/sdk").WorkflowBinding,
  ): import("@platform/sdk").WorkflowBinding =>
    binding.kind === "ref"
      ? { ...binding, path: remapPath(binding.path) }
      : binding.kind === "template"
        ? {
            ...binding,
            template: binding.template.replace(
              /\$\{([^}]+)\}/g,
              (_, path: string) => `\${${remapPath(path)}}`,
            ),
          }
        : binding;
  const next = structuredClone(current);
  const copiedNodes = nodes.map((n) => {
    const node = structuredClone(n);
    node.id = ids[n.id];
    node.label = `${node.label.slice(0, 75)} 副本`;
    if (node.type === "agent") node.prompt = remap(node.prompt);
    if (node.type === "tool")
      node.input = Object.fromEntries(
        Object.entries(node.input).map(([key, value]) => [key, remap(value)]),
      );
    if (node.type === "map" || node.type === "end")
      node.values = Object.fromEntries(
        Object.entries(node.values).map(([key, value]) => [key, remap(value)]),
      );
    if (node.type === "condition") {
      node.left = remap(node.left);
      if (node.right) node.right = remap(node.right);
    }
    return node;
  });
  next.definition.nodes.push(...copiedNodes);
  next.definition.edges.push(
    ...copied.definition.edges
      .filter((e) => ids[e.source] && ids[e.target])
      .map((e) => ({ ...e, source: ids[e.source], target: ids[e.target] })),
  );
  next.layout = { ...next.layout };
  const positions = copied.layout ?? {};
  for (const node of nodes)
    if (positions[node.id])
      next.layout[ids[node.id]] = {
        x: positions[node.id].x + offset,
        y: positions[node.id].y + offset,
      };
  return { next, ids: Object.values(ids) };
}
