import type { WorkflowAsset, WorkflowAssetInput } from "@platform/sdk";
import { objectSchema } from "./model/workflow-model";
export const draftOf = (asset: WorkflowAsset): WorkflowAssetInput => ({
  name: asset.name,
  description: asset.description,
  definition: asset.definition,
  layout: asset.layout ?? {},
});
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const normalizedDraft = (value: WorkflowAssetInput) => ({
  ...value,
  definition: {
    ...value.definition,
    nodes: [...value.definition.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...value.definition.edges].sort((a, b) =>
      `${a.source}/${a.port}/${a.target}`.localeCompare(`${b.source}/${b.port}/${b.target}`),
    ),
  },
});
export const same = (a: WorkflowAssetInput, b: WorkflowAssetInput) =>
  stable(normalizedDraft(a)) === stable(normalizedDraft(b));
export function initialInput(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(objectSchema(schema.properties)).map(([key, value]) => {
      const type = objectSchema(value).type;
      return [
        key,
        type === "number" || type === "integer"
          ? 0
          : type === "boolean"
            ? true
            : type === "array"
              ? []
              : type === "object"
                ? initialInput(objectSchema(value))
                : /order/i.test(key)
                  ? "ORD-1001"
                  : "请生成一份业务报告",
      ];
    }),
  );
}
export type RegisterGuard = (guard?: () => "busy" | "dirty" | null) => void;
