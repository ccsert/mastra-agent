import type { WorkflowBinding } from "@platform/sdk";
import { Input, Segmented, Select } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  acceptsBindingType,
  bindingSchemaType,
  defaultLiteral,
  valueType,
  valueTypes,
} from "../model/workflow-field-model";
import type { WorkflowVariableOption } from "../model/workflow-variables";
import { WorkflowVariablePicker } from "./WorkflowVariablePicker";

const PromptEditor = lazy(() => import("./WorkflowPromptEditor"));
export type BindingEditorProps = {
  label: string;
  value: WorkflowBinding;
  options: WorkflowVariableOption[];
  schema?: Record<string, unknown>;
  prompt?: boolean;
  onChange(value: WorkflowBinding): void;
  onValidity(valid: boolean): void;
  onUndo(): void;
  onRedo(): void;
};
export function WorkflowBindingEditor({
  label,
  value,
  options,
  schema = {},
  prompt = false,
  onChange,
  onValidity,
  onUndo,
  onRedo,
}: BindingEditorProps) {
  const canonicalValue = JSON.stringify(value);
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState("");
  const lastSent = useRef<string | undefined>(undefined);
  const validity = useRef(onValidity);
  validity.current = onValidity;
  useEffect(() => {
    // Preserve in-progress formatting (e.g. 1.0 or JSON indentation) during local typing.
    const ownUpdate = lastSent.current === canonicalValue;
    lastSent.current = undefined;
    if (ownUpdate) return;
    const current: WorkflowBinding = JSON.parse(canonicalValue);
    if (current.kind === "literal")
      setRaw(
        typeof current.value === "string" ? current.value : JSON.stringify(current.value, null, 2),
      );
    setParseError("");
  }, [canonicalValue]);
  const expectedType = typeof schema.type === "string" ? schema.type : undefined;
  const actualType = bindingSchemaType(value, options);
  const literalType = value.kind === "literal" ? valueType(value.value) : "string";
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((v) => ["string", "number", "boolean"].includes(typeof v) || v === null)
    : [];
  const typeError = !acceptsBindingType(actualType, expectedType)
    ? `此字段需要${valueTypes.find((v) => v.value === expectedType)?.label ?? expectedType}，当前为 ${actualType}。`
    : expectedType === "integer" && value.kind === "literal" && !Number.isInteger(value.value)
      ? "请输入整数。"
      : value.kind === "literal" && enumValues.length && !enumValues.includes(value.value)
        ? "请选择约定范围内的值。"
        : "";
  const text =
    value.kind === "template"
      ? value.template
      : value.kind === "literal" && typeof value.value === "string"
        ? value.value
        : "";
  const error =
    parseError ||
    typeError ||
    (text.length > 16000 ? "最多支持 16,000 个字符，请缩短内容。" : "") ||
    (prompt && value.kind !== "ref" && !text.trim() ? "请填写交给 Agent 的任务。" : "");
  useEffect(() => {
    validity.current(!error);
  }, [error]);
  useEffect(() => () => validity.current(true), []);
  const change = (next: WorkflowBinding, preserveRaw = false) => {
    setParseError("");
    lastSent.current = JSON.stringify(next);
    if (!preserveRaw && next.kind === "literal")
      setRaw(typeof next.value === "string" ? next.value : JSON.stringify(next.value, null, 2));
    onChange(next);
  };
  const types = prompt ? valueTypes.filter((v) => v.value === "string") : valueTypes;
  const sourceOptions = [
    { value: "ref", label: "引用变量" },
    { value: "literal", label: prompt ? "纯文本" : "固定值" },
    ...(!expectedType || expectedType === "string" || value.kind === "template"
      ? [{ value: "template", label: prompt ? "编写任务" : "文本模板" }]
      : []),
  ];
  if (prompt)
    sourceOptions.sort((a, b) => Number(b.value === "template") - Number(a.value === "template"));
  return (
    <div className={`workflow-binding ${error ? "has-error" : ""}`}>
      <div className="workflow-binding-controls">
        <Segmented
          size="small"
          aria-label={`${label}来源`}
          value={value.kind}
          options={sourceOptions}
          onChange={(kind) => {
            const currentText =
              value.kind === "template"
                ? value.template
                : value.kind === "literal" && typeof value.value === "string"
                  ? value.value
                  : "";
            change(
              kind === "ref"
                ? {
                    kind,
                    path:
                      options.find((v) => !v.optional && acceptsBindingType(v.type, expectedType))
                        ?.value ?? "",
                  }
                : kind === "template"
                  ? {
                      kind,
                      template:
                        value.kind === "ref" && value.path ? `\${${value.path}}` : currentText,
                    }
                  : {
                      kind: "literal",
                      value:
                        expectedType && expectedType !== "string"
                          ? defaultLiteral(expectedType)
                          : currentText,
                    },
            );
          }}
        />
        {value.kind === "literal" && !prompt && (!expectedType || typeError) && (
          <Select
            className="workflow-value-type"
            variant="borderless"
            size="small"
            aria-label={`${label}值类型`}
            value={literalType}
            options={types}
            onChange={(type) => change({ kind: "literal", value: defaultLiteral(type) })}
          />
        )}
      </div>
      {value.kind === "ref" && (
        <>
          <WorkflowVariablePicker
            label={`${label}变量`}
            value={value.path}
            options={options}
            acceptType={expectedType}
            onChange={(path) => change({ kind: "ref", path })}
          />
          {value.path && <code className="workflow-binding-path">{value.path}</code>}
        </>
      )}
      {value.kind === "template" ||
      (prompt && value.kind === "literal" && typeof value.value === "string") ? (
        <Suspense fallback={<div className="workflow-editor-loading">正在加载提示词编辑器…</div>}>
          <PromptEditor
            label={prompt ? "任务提示词" : `${label}模板`}
            value={text}
            template={value.kind === "template"}
            options={options}
            compact={!prompt}
            onChange={(text) =>
              change(
                value.kind === "template"
                  ? { kind: "template", template: text }
                  : { kind: "literal", value: text },
              )
            }
            onUndo={onUndo}
            onRedo={onRedo}
          />
        </Suspense>
      ) : (
        value.kind === "literal" &&
        (enumValues.length > 0 ? (
          <Select
            aria-label={`${label}固定值`}
            value={JSON.stringify(value.value)}
            options={enumValues.map((v) => ({ value: JSON.stringify(v), label: String(v) }))}
            onChange={(v) => change({ kind: "literal", value: JSON.parse(v) })}
          />
        ) : literalType === "boolean" ? (
          <Segmented
            block
            aria-label={`${label}布尔值`}
            value={String(value.value)}
            options={[
              { value: "true", label: "真 · true" },
              { value: "false", label: "假 · false" },
            ]}
            onChange={(v) => change({ kind: "literal", value: v === "true" })}
          />
        ) : literalType === "null" ? (
          <div className="workflow-null-value">
            null <span>表示明确的空值</span>
          </div>
        ) : literalType === "number" ? (
          <Input
            aria-label={`${label}数值`}
            type="number"
            step={expectedType === "integer" ? 1 : "any"}
            value={raw}
            status={error ? "error" : undefined}
            placeholder="输入数值，例如 100"
            onChange={(event) => {
              const next = event.target.value;
              setRaw(next);
              if (!next.trim() || !Number.isFinite(Number(next))) setParseError("请输入有效数值。");
              else change({ kind: "literal", value: Number(next) }, true);
            }}
          />
        ) : (
          <Input.TextArea
            aria-label={`${label}固定值`}
            className={literalType === "string" ? undefined : "workflow-json-input"}
            value={raw}
            status={error ? "error" : undefined}
            autoSize={{ minRows: literalType === "string" ? 2 : 5, maxRows: 12 }}
            placeholder={
              literalType === "string"
                ? "输入文本内容"
                : literalType === "array"
                  ? '["值 1", "值 2"]'
                  : '{ "key": "value" }'
            }
            onChange={(event) => {
              const next = event.target.value;
              setRaw(next);
              try {
                const parsed = literalType === "string" ? next : JSON.parse(next);
                if (valueType(parsed) !== literalType) throw new Error();
                change({ kind: "literal", value: parsed }, true);
              } catch {
                setParseError(`请输入有效的 JSON ${literalType === "array" ? "数组" : "对象"}。`);
              }
            }}
          />
        ))
      )}
      {!!error && (
        <small className="workflow-field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
