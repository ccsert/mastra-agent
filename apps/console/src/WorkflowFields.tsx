import type {
  WorkflowBinding,
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowNode,
} from "@platform/sdk";
import { Alert, Button, Form, Input, Select, Space } from "antd";
import { useState } from "react";
import { nodeNames, objectSchema, variables } from "./workflow-model";

function BindingEditor({
  label,
  value,
  options,
  onChange,
  onValidity,
}: {
  label: string;
  value: WorkflowBinding;
  options: ReturnType<typeof variables>;
  onChange(value: WorkflowBinding): void;
  onValidity(valid: boolean): void;
}) {
  const initialType = value.kind === "literal" ? typeof value.value : "string";
  const [literalType, setLiteralType] = useState(
      ["string", "number", "boolean"].includes(initialType) ? initialType : "json",
    ),
    [invalid, setInvalid] = useState(false);
  const [raw, setRaw] = useState(
    value.kind === "literal"
      ? typeof value.value === "string"
        ? value.value
        : JSON.stringify(value.value)
      : "",
  );
  const valid = (next: boolean) => {
    setInvalid(!next);
    onValidity(next);
  };
  return (
    <div className="workflow-binding">
      <Select
        aria-label={`${label}来源`}
        value={value.kind}
        options={[
          { value: "ref", label: "引用变量" },
          { value: "literal", label: "固定值" },
          { value: "template", label: "文本模板" },
        ]}
        onChange={(kind) => {
          valid(true);
          setRaw("");
          setLiteralType("string");
          onChange(
            kind === "ref"
              ? { kind, path: options.find((v) => !v.optional)?.value ?? "input" }
              : kind === "template"
                ? { kind, template: "" }
                : { kind, value: "" },
          );
        }}
      />
      {value.kind === "ref" && (
        <Select
          aria-label={`${label}变量`}
          showSearch={{ optionFilterProp: "label" }}
          value={value.path}
          options={options.map((o) => ({ label: o.label, value: o.value, disabled: o.optional }))}
          onChange={(path) => onChange({ kind: "ref", path })}
        />
      )}
      {value.kind === "template" && (
        <>
          <Input.TextArea
            aria-label={`${label}模板`}
            value={value.template}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={16000}
            onChange={(e) => onChange({ kind: "template", template: e.target.value })}
          />
          <Select
            aria-label={`插入${label}变量`}
            placeholder="插入上游变量"
            value={null}
            showSearch={{ optionFilterProp: "label" }}
            options={options
              .filter((o) => !o.optional)
              .map((o) => ({ label: o.label, value: o.value }))}
            onChange={(path) =>
              onChange({ kind: "template", template: `${value.template}\${${path}}` })
            }
          />
        </>
      )}
      {value.kind === "literal" && (
        <>
          <Select
            aria-label={`${label}值类型`}
            value={literalType}
            options={[
              { value: "string", label: "文本" },
              { value: "number", label: "数值" },
              { value: "boolean", label: "布尔值" },
              { value: "json", label: "JSON" },
            ]}
            onChange={(type) => {
              setLiteralType(type);
              valid(true);
              const next =
                type === "number" ? 0 : type === "boolean" ? true : type === "json" ? {} : "";
              setRaw(typeof next === "string" ? next : JSON.stringify(next));
              onChange({ kind: "literal", value: next });
            }}
          />
          <Input.TextArea
            aria-label={`${label}固定值`}
            value={raw}
            status={invalid ? "error" : undefined}
            autoSize={{ minRows: 1, maxRows: 5 }}
            maxLength={16000}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                const parsed =
                  literalType === "string" ? e.target.value : JSON.parse(e.target.value);
                if (
                  (literalType === "number" && typeof parsed !== "number") ||
                  (literalType === "boolean" && typeof parsed !== "boolean")
                )
                  throw new Error();
                valid(true);
                onChange({ kind: "literal", value: parsed });
              } catch {
                valid(false);
              }
            }}
          />
          {invalid && (
            <small role="alert">
              请输入有效的
              {literalType === "number"
                ? "数值"
                : literalType === "boolean"
                  ? " true 或 false"
                  : " JSON"}
              。
            </small>
          )}
        </>
      )}
    </div>
  );
}
export function WorkflowNodeFields({
  initial,
  definition,
  catalog,
  onApply,
  onDelete,
}: {
  initial: WorkflowNode;
  definition: WorkflowDefinition;
  catalog: WorkflowCapability[];
  onApply(node: WorkflowNode): void;
  onDelete(): void;
}) {
  const [node, setNode] = useState(initial),
    [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({}),
    [newField, setNewField] = useState("");
  const options = variables(definition, node.id, catalog);
  const binding = (
    label: string,
    value: WorkflowBinding,
    update: (v: WorkflowBinding) => void,
    allowOptional = false,
  ) => (
    <BindingEditor
      key={`${node.id}-${label}`}
      label={label}
      value={value}
      options={allowOptional ? options.map((v) => ({ ...v, optional: false })) : options}
      onChange={update}
      onValidity={(valid) => setInvalidFields((previous) => ({ ...previous, [label]: !valid }))}
    />
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
  return (
    <div className="workflow-node-fields">
      <p className="muted">
        {nodeNames[node.type]} · {node.id}
      </p>
      <Form layout="vertical" component="div">
        <Form.Item label="节点名称" htmlFor="workflow-node-label" required>
          <Input
            id="workflow-node-label"
            value={node.label}
            maxLength={80}
            onChange={(e) => setNode({ ...node, label: e.target.value })}
          />
        </Form.Item>
        {node.type === "start" && (
          <Alert
            type="info"
            title="输入字段在流程设置中配置"
            description="AI 会根据任务生成输入与输出；你也可以通过“流程设置”调整。"
          />
        )}
        {(node.type === "tool" || node.type === "agent") && (
          <>
            <Form.Item
              label={node.type === "agent" ? "已发布 Agent" : "业务工具"}
              htmlFor="workflow-node-resource"
            >
              <Select
                id="workflow-node-resource"
                showSearch={{ optionFilterProp: "label" }}
                value={node.type === "agent" ? node.releaseId : node.toolId}
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
            </Form.Item>
            {entry && <p className="muted">{entry.description || "此节点使用固定发布的能力。"}</p>}
          </>
        )}
        {node.type === "agent" && (
          <Form.Item label="交给 Agent 的任务">
            {binding("任务", node.prompt, (prompt) => setNode({ ...node, prompt }))}
          </Form.Item>
        )}
        {node.type === "condition" && (
          <>
            <Form.Item label="判断对象">
              {binding(
                "判断对象",
                node.left,
                (left) => setNode({ ...node, left }),
                node.operator === "exists",
              )}
            </Form.Item>
            <Form.Item label="判断方式" htmlFor="workflow-condition-op">
              <Select
                id="workflow-condition-op"
                value={node.operator}
                options={[
                  { value: "eq", label: "等于" },
                  { value: "neq", label: "不等于" },
                  { value: "exists", label: "存在且非空" },
                  { value: "gt", label: "大于" },
                  { value: "gte", label: "大于等于" },
                  { value: "lt", label: "小于" },
                  { value: "lte", label: "小于等于" },
                ]}
                onChange={(operator) => {
                  const { right: _right, ...rest } = node;
                  setNode({
                    ...rest,
                    operator,
                    ...(operator === "exists"
                      ? {}
                      : { right: node.right ?? { kind: "literal", value: "" } }),
                  });
                }}
              />
            </Form.Item>
            {node.operator !== "exists" && (
              <Form.Item label="比较值">
                {binding("比较值", node.right ?? { kind: "literal", value: "" }, (right) =>
                  setNode({ ...node, right }),
                )}
              </Form.Item>
            )}
            <Alert
              type="info"
              title="满足与不满足各执行一条路径"
              description="分别连接到后续步骤，每条路径独立结束。"
            />
          </>
        )}
        {fieldValues &&
          keys.map((key) => (
            <Form.Item
              key={key}
              label={`${key}${Array.isArray(schema?.required) && schema.required.includes(key) ? " · 必填" : ""}`}
            >
              {binding(key, fieldValues[key] ?? { kind: "literal", value: "" }, (value) =>
                setBinding(key, value),
              )}
              {fieldValues[key] && (
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    const next = { ...fieldValues };
                    delete next[key];
                    if (node.type === "tool") setNode({ ...node, input: next });
                    else if (node.type === "map" || node.type === "end")
                      setNode({ ...node, values: next });
                    setInvalidFields((previous) => ({ ...previous, [key]: false }));
                  }}
                >
                  移除此字段
                </Button>
              )}
            </Form.Item>
          ))}
        {node.type === "map" && (
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
                ["__proto__", "constructor", "prototype"].includes(newField)
              }
              onClick={() => {
                setBinding(newField, { kind: "literal", value: "" });
                setNewField("");
              }}
            >
              添加字段
            </Button>
          </Space.Compact>
        )}
        <div className="workflow-field-actions">
          <Button
            type="primary"
            disabled={!node.label.trim() || Object.values(invalidFields).some(Boolean)}
            onClick={() => onApply(node)}
          >
            应用配置
          </Button>
          {node.type !== "start" && (
            <Button danger onClick={onDelete}>
              删除节点
            </Button>
          )}
        </div>
      </Form>
    </div>
  );
}
