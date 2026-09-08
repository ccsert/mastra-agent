import {
  Field,
  Form as FlowForm,
  type FreeLayoutPluginContext,
  useInitializedFormModel,
  useWatchFormValues,
  type WorkflowNodeEntity,
} from "@flowgram.ai/free-layout-editor";
import type {
  WorkflowBinding,
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowNode,
} from "@platform/sdk";
import { Button, Form, Input, Select, Space } from "antd";
import { useEffect, useState } from "react";
import { WorkflowBindingEditor } from "./WorkflowBindingEditor";
import {
  bindingType,
  conditionOperators,
  conditionTypeIssue,
  defaultLiteral,
  describeBinding,
  numericOperators,
} from "./workflow-field-model";
import { objectSchema } from "./workflow-model";
import type { WorkflowVariableOption } from "./workflow-variables";

export function WorkflowNodeFields(props: {
  entity: WorkflowNodeEntity;
  definition: WorkflowDefinition;
  catalog: WorkflowCapability[];
  options: WorkflowVariableOption[];
  context: FreeLayoutPluginContext;
  onClose(): void;
  onDelete(): void;
  onValidity(valid: boolean): void;
}) {
  const { onValidity } = props;
  useEffect(() => () => onValidity(true), [onValidity]);
  const model = useInitializedFormModel(props.entity);
  if (!model.formControl) return null;
  return (
    <FlowForm control={model.formControl} keepModelOnUnMount>
      <NodeFields {...props} />
    </FlowForm>
  );
}
function NodeFields({
  entity,
  definition,
  catalog,
  options,
  context,
  onClose,
  onDelete,
  onValidity,
}: Parameters<typeof WorkflowNodeFields>[0]) {
  const node = useWatchFormValues<WorkflowNode>(entity);
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const [newField, setNewField] = useState("");
  const conditionIssue = node?.type === "condition" ? conditionTypeIssue(node, options) : undefined;
  const valid =
    !!node?.label.trim() && !conditionIssue && !Object.values(invalidFields).some(Boolean);
  useEffect(() => {
    onValidity(valid);
  }, [valid, onValidity]);
  if (!node) return null;
  const setNode = (update: WorkflowNode | ((current: WorkflowNode) => WorkflowNode)) => {
    const model = entity.form;
    if (!model) return;
    const current = model.values as WorkflowNode;
    const next = typeof update === "function" ? update(current) : update;
    context.history.startTransaction();
    try {
      for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
        const value = (next as unknown as Record<string, unknown>)[key];
        if (
          JSON.stringify(value) !==
          JSON.stringify((current as unknown as Record<string, unknown>)[key])
        )
          model.setValueIn(key, value);
      }
    } finally {
      context.history.endTransaction();
    }
  };
  const binding = (
    name: string,
    label: string,
    value: WorkflowBinding,
    config: { allowOptional?: boolean; schema?: Record<string, unknown>; prompt?: boolean } = {},
  ) => (
    <Field<WorkflowBinding> name={name}>
      {({ field, fieldState }) => (
        <div>
          <WorkflowBindingEditor
            key={`${node.id}-${name}`}
            label={label}
            value={field.value ?? value}
            options={
              config.allowOptional ? options.map((v) => ({ ...v, optional: false })) : options
            }
            schema={config.schema}
            prompt={config.prompt}
            onChange={field.onChange}
            onUndo={() => {
              void context.history.undo();
            }}
            onRedo={() => {
              void context.history.redo();
            }}
            onValidity={(valid) =>
              setInvalidFields((previous) =>
                previous[name] === !valid ? previous : { ...previous, [name]: !valid },
              )
            }
          />
          {fieldState.errors?.map((error) => (
            <small className="workflow-field-error" role="alert" key={String(error.message)}>
              {error.message}
            </small>
          ))}
        </div>
      )}
    </Field>
  );
  const entry = catalog.find(
    (c) =>
      (node.type === "tool" && c.kind === "tool" && c.id === node.toolId) ||
      (node.type === "agent" && c.kind === "agent" && c.id === node.releaseId),
  );
  const fieldValues =
    node.type === "tool"
      ? node.input
      : node.type === "end" || node.type === "map"
        ? node.values
        : null;
  const schema =
    node.type === "tool"
      ? entry?.inputSchema
      : node.type === "end"
        ? definition.outputSchema
        : null;
  const keys = [
    ...new Set([
      ...Object.keys(objectSchema(schema?.properties)),
      ...Object.keys(fieldValues ?? {}),
    ]),
  ];
  const setBinding = (name: string, value: WorkflowBinding) =>
    setNode((current) =>
      current.type === "tool"
        ? { ...current, input: { ...current.input, [name]: value } }
        : current.type === "map" || current.type === "end"
          ? { ...current, values: { ...current.values, [name]: value } }
          : current,
    );
  const leftType = node.type === "condition" ? bindingType(node.left, options) : undefined;
  const branchTarget = (port: string) => {
    const edge = definition.edges.find((e) => e.source === node.id && e.port === port);
    return definition.nodes.find((n) => n.id === edge?.target)?.label;
  };
  const sectionHelp: Record<WorkflowNode["type"], string> = {
    start: "定义流程接收的数据，后续节点可将它们作为变量引用。",
    agent: "把这一步的任务交给已发布 Agent，沿用该版本的角色与工具授权。",
    condition: "根据上游数据判断走向，满足条件和否则分别进入不同分支。",
    tool: "为业务工具绑定输入参数，执行结果可供后续节点引用。",
    map: "把上游变量和固定值整理成新字段，供后续步骤使用。",
    end: "为流程返回字段赋值，这些数据会返回给调用方。",
  };
  return (
    <div className={`workflow-node-fields workflow-fields-${node.type}`}>
      <p className="workflow-node-purpose">{sectionHelp[node.type]}</p>
      <Form layout="vertical" component="div">
        <Field<string> name="label">
          {({ field, fieldState }) => (
            <Form.Item
              label="节点名称"
              htmlFor="workflow-node-label"
              required
              validateStatus={fieldState.errors?.length ? "error" : undefined}
              help={fieldState.errors?.map((e) => e.message).join("；")}
            >
              <Input
                id="workflow-node-label"
                value={field.value}
                maxLength={80}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
              />
            </Form.Item>
          )}
        </Field>
        {node.type === "start" && (
          <section className="workflow-field-section">
            <h3>流程输入</h3>
            <p className="workflow-field-help">
              调用方在启动流程时提供。字段名称、类型和必填规则可在“流程设置”中调整。
            </p>
            <SchemaOverview schema={definition.inputSchema} empty="此流程不要求输入参数。" />
          </section>
        )}
        {(node.type === "tool" || node.type === "agent") && (
          <section className="workflow-field-section">
            <h3>{node.type === "agent" ? "执行 Agent" : "业务工具"}</h3>
            <Select
              id="workflow-node-resource"
              aria-label={node.type === "agent" ? "已发布 Agent" : "业务工具"}
              showSearch={{ optionFilterProp: "label" }}
              value={node.type === "agent" ? node.releaseId : node.toolId}
              placeholder="选择已发布的能力"
              options={catalog
                .filter((c) => c.kind === node.type)
                .map((c) => ({ label: `${c.name} · v${c.version}`, value: c.id }))}
              onChange={(id) => {
                if (node.type === "agent") setNode({ ...node, releaseId: id });
                if (node.type === "tool") {
                  setInvalidFields({});
                  setNode({ ...node, toolId: id, input: {} });
                }
              }}
            />
            {entry ? (
              <p className="workflow-field-help">
                {entry.description || "使用此能力的固定发布版本。"}
              </p>
            ) : (
              <p className="workflow-field-error">请选择可用的已发布资源。</p>
            )}
          </section>
        )}
        {node.type === "agent" && (
          <section className="workflow-field-section">
            <h3>
              任务提示词 <span className="workflow-required-label">必填</span>
            </h3>
            <p className="workflow-field-help">
              说明这一步要做什么、依据什么信息，以及期望的输出。可插入上游变量提供上下文。
            </p>
            {binding("prompt", "任务", node.prompt, { schema: { type: "string" }, prompt: true })}
          </section>
        )}
        {node.type === "condition" && (
          <section className="workflow-field-section">
            <h3>分支规则</h3>
            <div className="workflow-condition-rule">
              <div className="workflow-rule-heading">
                <span>IF</span>
                <strong>满足以下条件</strong>
              </div>
              <Form.Item label="判断哪个值">
                {binding("left", "判断对象", node.left, {
                  allowOptional: node.operator === "exists",
                })}
              </Form.Item>
              <div className="workflow-condition-compare">
                <label htmlFor="workflow-condition-op">判断关系</label>
                <Select
                  id="workflow-condition-op"
                  value={node.operator}
                  options={conditionOperators.map((op) => ({
                    value: op.value,
                    label: `${op.symbol}  ${op.label}`,
                    disabled:
                      numericOperators.includes(op.value) && !!leftType && leftType !== "number",
                  }))}
                  onChange={(operator) => {
                    const { right: _right, ...rest } = node;
                    setInvalidFields((previous) => ({ ...previous, right: false }));
                    setNode({
                      ...rest,
                      operator,
                      ...(operator === "exists"
                        ? {}
                        : {
                            right: node.right ?? {
                              kind: "literal",
                              value: defaultLiteral(leftType),
                            },
                          }),
                    });
                  }}
                />
              </div>
              {node.operator !== "exists" ? (
                <Form.Item label="与什么值比较">
                  {binding(
                    "right",
                    "比较值",
                    node.right ?? { kind: "literal", value: defaultLiteral(leftType) },
                    {
                      schema:
                        leftType && !["未知", "any"].includes(leftType) ? { type: leftType } : {},
                    },
                  )}
                </Form.Item>
              ) : (
                <p className="workflow-field-help">
                  字段存在且不为 null 即满足条件；空字符串、0 和 false 仍然算有值。
                </p>
              )}
              {conditionIssue && (
                <p className="workflow-field-error" role="alert">
                  {conditionIssue}
                </p>
              )}
              <div className="workflow-condition-summary">
                <span>当前规则</span>
                <p>
                  {describeBinding(node.left, options)}{" "}
                  <strong>
                    {conditionOperators.find((o) => o.value === node.operator)?.label}
                  </strong>{" "}
                  {node.operator !== "exists" && describeBinding(node.right, options)}
                </p>
              </div>
            </div>
            <div className="workflow-branch-routes">
              <div>
                <span className="workflow-route-label is-true">满足 IF</span>
                <span aria-hidden="true">→</span>
                <strong>{branchTarget("true") || "尚未连接后续节点"}</strong>
              </div>
              <div>
                <span className="workflow-route-label">否则 ELSE</span>
                <span aria-hidden="true">→</span>
                <strong>{branchTarget("false") || "尚未连接后续节点"}</strong>
              </div>
            </div>
          </section>
        )}
        {fieldValues && (
          <section className="workflow-field-section">
            <h3>
              {node.type === "tool" ? "输入参数" : node.type === "end" ? "返回结果" : "字段映射"}{" "}
              <span className="workflow-section-count">{keys.length}</span>
            </h3>
            {keys.length === 0 && (
              <p className="workflow-field-help">
                {node.type === "map"
                  ? "添加输出字段，并指定每个字段的数据来源。"
                  : "此节点没有需要配置的字段。"}
              </p>
            )}
            {keys.map((key) => {
              const property = objectSchema(objectSchema(schema?.properties)[key]);
              const required = Array.isArray(schema?.required) && schema.required.includes(key);
              const name = `${node.type === "tool" ? "input" : "values"}.${key}`;
              return (
                <div className="workflow-parameter" key={key}>
                  <div className="workflow-parameter-heading">
                    <strong>{typeof property.title === "string" ? property.title : key}</strong>
                    {property.title && property.title !== key ? <code>{key}</code> : null}
                    <span className="workflow-type-tag">
                      {String(property.type ?? bindingType(fieldValues[key], options) ?? "待配置")}
                    </span>
                    {required && <span className="workflow-required-label">必填</span>}
                    {fieldValues[key] && !required && (
                      <Button
                        type="text"
                        size="small"
                        aria-label={`移除 ${key} 字段`}
                        onClick={() => {
                          const next = { ...fieldValues };
                          delete next[key];
                          if (node.type === "tool") setNode({ ...node, input: next });
                          else if (node.type === "map" || node.type === "end")
                            setNode({ ...node, values: next });
                          setInvalidFields((previous) => ({ ...previous, [name]: false }));
                        }}
                      >
                        移除
                      </Button>
                    )}
                  </div>
                  {typeof property.description === "string" && (
                    <p className="workflow-field-help">{property.description}</p>
                  )}
                  {fieldValues[key] ? (
                    binding(name, key, fieldValues[key], { schema: property })
                  ) : (
                    <Button
                      block
                      type="dashed"
                      onClick={() =>
                        setBinding(key, {
                          kind: "literal",
                          value: property.default ?? defaultLiteral(String(property.type)),
                        })
                      }
                    >
                      {required ? "配置必填字段" : "设置此可选字段"}
                    </Button>
                  )}
                </div>
              );
            })}
            {node.type === "map" && (
              <div className="workflow-map-add">
                <Space.Compact block>
                  <Input
                    aria-label="新增映射字段名"
                    value={newField}
                    placeholder="字段名，如 summary"
                    onChange={(e) => setNewField(e.target.value)}
                  />
                  <Button
                    disabled={
                      !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(newField) ||
                      ["__proto__", "constructor", "prototype"].includes(newField) ||
                      Object.hasOwn(fieldValues, newField)
                    }
                    onClick={() => {
                      setBinding(newField, { kind: "literal", value: "" });
                      setNewField("");
                    }}
                  >
                    添加字段
                  </Button>
                </Space.Compact>
                {Object.hasOwn(fieldValues, newField) && (
                  <small className="workflow-field-error">字段已存在，请使用不同的名称。</small>
                )}
              </div>
            )}
          </section>
        )}
        {entry && (
          <section className="workflow-field-section">
            <h3>可供后续引用的输出</h3>
            <SchemaOverview schema={entry.outputSchema} empty="此能力没有声明输出字段。" />
          </section>
        )}
        <div className="workflow-field-actions">
          <span>修改后需保存草稿</span>
          <Button disabled={!valid} onClick={onClose}>
            收起配置
          </Button>
          {node.type !== "start" && (
            <Button danger type="text" onClick={onDelete}>
              删除节点
            </Button>
          )}
        </div>
      </Form>
    </div>
  );
}
function SchemaOverview({
  schema,
  empty,
  depth = 0,
}: {
  schema?: Record<string, unknown>;
  empty: string;
  depth?: number;
}) {
  const properties = objectSchema(schema?.properties);
  if (!Object.keys(properties).length) return <p className="workflow-field-help">{empty}</p>;
  return (
    <div className="workflow-schema-overview">
      {Object.entries(properties).map(([name, value]) => {
        const field = objectSchema(value),
          children = field.type === "array" ? objectSchema(field.items) : field;
        return (
          <div className="workflow-schema-field" key={name}>
            <div>
              <code>{name}</code>
              <span className="workflow-type-tag">{String(field.type ?? "unknown")}</span>
              {Array.isArray(schema?.required) && schema.required.includes(name) && (
                <span className="workflow-required-label">必填</span>
              )}
            </div>
            {typeof field.description === "string" && <p>{field.description}</p>}
            {depth < 3 && Object.keys(objectSchema(children.properties)).length > 0 && (
              <details>
                <summary>查看{field.type === "array" ? "数组项" : "子字段"}结构</summary>
                <SchemaOverview schema={children} empty="" depth={depth + 1} />
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
