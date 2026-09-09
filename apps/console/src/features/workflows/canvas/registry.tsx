import {
  Field,
  type FormMeta,
  type FreeLayoutPluginContext,
  ValidateTrigger,
} from "@flowgram.ai/free-layout-editor";
import type { WorkflowAssetInput, WorkflowCapability, WorkflowNode } from "@platform/sdk";
import { nodeNames, objectSchema } from "../model/workflow-model";
import { workflowVariableIssue } from "../model/workflow-variables";

const formMeta: FormMeta = {
  validateTrigger: ValidateTrigger.onChange,
  // Match the API's label normalization at the document boundary, including undo/redo exports.
  formatOnSubmit: (values: WorkflowNode) => ({ ...values, label: values.label.trim() }),
  render: () => <Field<string> name="label">{({ field }) => <strong>{field.value}</strong>}</Field>,
  validate: {
    label: ({ value }) =>
      typeof value === "string" && value.trim() ? undefined : "请输入节点名称",
  },
};
const registries = Object.keys(nodeNames).map((type) => ({
  type,
  formMeta,
  meta: {
    size: { width: 280, height: type === "condition" ? 225 : 160 },
    isStart: type === "start",
    deleteDisable: type === "start",
    copyDisable: type === "start",
    nodePanelVisible: type !== "start",
    defaultPorts: [
      ...(type === "start" ? [] : [{ type: "input" as const, portID: "in" }]),
      ...(type === "end"
        ? []
        : type === "condition"
          ? [
              { type: "output" as const, portID: "true", locationConfig: { right: 0, top: "72%" } },
              {
                type: "output" as const,
                portID: "false",
                locationConfig: { right: 0, top: "90%" },
              },
            ]
          : [{ type: "output" as const, portID: "out" }]),
    ],
  },
}));
export function createNodeRegistries(
  current: () => {
    catalog: WorkflowCapability[] | undefined;
    context: FreeLayoutPluginContext | null;
    outputSchema: WorkflowAssetInput["definition"]["outputSchema"];
  },
) {
  return registries.map((registry) => ({
    ...registry,
    formMeta: {
      ...formMeta,
      validate: (values: WorkflowNode) => {
        const { catalog, outputSchema } = current();
        const validators: NonNullable<FormMeta["validate"]> = {
          label: ({ value }) =>
            typeof value === "string" && value.trim() ? undefined : "请输入节点名称",
        };
        const entry = catalog?.find(
          (c) =>
            (values.type === "tool" && c.kind === "tool" && c.id === values.toolId) ||
            (values.type === "agent" && c.kind === "agent" && c.id === values.releaseId),
        );
        const binding =
          (required = true, optional = false) =>
          ({ value }: { value: unknown }) => {
            if (!value) return required ? "请配置此字段" : undefined;
            const v = objectSchema(value);
            const paths =
              v.kind === "ref"
                ? [String(v.path)]
                : v.kind === "template"
                  ? [...String(v.template).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1])
                  : [];
            for (const path of paths) {
              const context = current().context;
              if (!context) continue;
              const issue = workflowVariableIssue(context, values.id, path, optional);
              if (issue) return issue;
            }
            return undefined;
          };
        if (values.type === "tool" || values.type === "agent")
          validators[values.type === "tool" ? "toolId" : "releaseId"] = () =>
            entry ? undefined : "请选择可用的已发布资源";
        if (values.type === "agent") validators.prompt = binding();
        if (values.type === "condition") {
          validators.left = binding(true, values.operator === "exists");
          if (values.operator !== "exists") validators.right = binding();
        }
        if (values.type === "tool" || values.type === "map" || values.type === "end") {
          const schema =
            values.type === "tool"
              ? entry?.inputSchema
              : values.type === "end"
                ? outputSchema
                : undefined;
          const fields = values.type === "tool" ? values.input : values.values;
          for (const key of new Set([
            ...Object.keys(fields),
            ...Object.keys(objectSchema(schema?.properties)),
          ]))
            validators[`${values.type === "tool" ? "input" : "values"}.${key}`] = binding(
              Array.isArray(schema?.required) && schema.required.includes(key),
            );
        }
        return validators;
      },
    } satisfies FormMeta,
  }));
}
