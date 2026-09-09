import type { WorkflowJSON } from "@flowgram.ai/free-layout-editor";
import type { WorkflowAssetInput, WorkflowNode } from "@platform/sdk";
export function documentFor(value: WorkflowAssetInput): WorkflowJSON {
  return {
    nodes: value.definition.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: structuredClone(n),
      meta: { position: value.layout?.[n.id] ?? { x: 0, y: 0 } },
    })),
    edges: value.definition.edges.map((e) => ({
      sourceNodeID: e.source,
      targetNodeID: e.target,
      sourcePortID: e.port,
      targetPortID: "in",
    })),
  };
}
export type WorkflowMetadata = Pick<WorkflowAssetInput, "name" | "description"> &
  Pick<WorkflowAssetInput["definition"], "inputSchema" | "outputSchema">;
export const metadataOf = (value: WorkflowAssetInput): WorkflowMetadata => ({
  name: value.name,
  description: value.description,
  inputSchema: value.definition.inputSchema,
  outputSchema: value.definition.outputSchema,
});
export function captureDocument(source: WorkflowAssetInput, doc: WorkflowJSON): WorkflowAssetInput {
  const nodes = doc.nodes.map((n) => {
    const data = n.data as WorkflowNode;
    if (!data || data.id !== n.id || data.type !== n.type)
      throw new Error("节点数据与画布标识不一致，请重新加载");
    return structuredClone(data);
  });
  const edges = (doc.edges ?? []).map((e) => {
    if (!["out", "true", "false"].includes(String(e.sourcePortID)) || e.targetPortID !== "in")
      throw new Error("连线端口不符合流程约束");
    return {
      source: e.sourceNodeID,
      target: e.targetNodeID,
      port: e.sourcePortID as "out" | "true" | "false",
    };
  });
  return {
    ...source,
    definition: { ...source.definition, nodes, edges },
    layout: Object.fromEntries(doc.nodes.map((n) => [n.id, n.meta?.position ?? { x: 0, y: 0 }])),
  };
}
