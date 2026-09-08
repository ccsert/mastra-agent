import { ExpandOutlined } from "@ant-design/icons";
import { Transaction } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from "@codemirror/view";
import preset, { type EditorAPI, languageSupport } from "@flowgram.ai/coze-editor/preset-prompt";
import { EditorProvider, Renderer } from "@flowgram.ai/coze-editor/react";
import { Button, Modal } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkflowVariablePicker } from "./WorkflowVariablePicker";
import { promptVariables, variableName } from "./workflow-field-model";
import type { WorkflowVariableOption } from "./workflow-variables";

/** Official prompt preset with the platform's ${path} variable syntax and FlowGram history. */
export default function WorkflowPromptEditor({
  value,
  template,
  options,
  onChange,
  onUndo,
  onRedo,
  label = "任务提示词",
  compact = false,
}: {
  value: string;
  template: boolean;
  options: WorkflowVariableOption[];
  onChange(value: string): void;
  onUndo(): void;
  onRedo(): void;
  label?: string;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const editor = useRef<EditorAPI | null>(null);
  const selection = useRef({ from: 0, to: 0 });
  const syncing = useRef(false);
  const tokens = template ? promptVariables(value) : [];
  const extensions = useMemo(() => {
    const matcher = new MatchDecorator({
      regexp: template
        ? /\$\{[^}\n]+\}|^#{1,6} .+|\*\*[^*\n]+\*\*/g
        : /^#{1,6} .+|\*\*[^*\n]+\*\*/g,
      decoration: (match) =>
        Decoration.mark({
          class: match[0].startsWith("${") ? "workflow-prompt-token" : "workflow-prompt-heading",
          attributes: match[0].startsWith("${")
            ? { title: variableName(match[0].slice(2, -1), options) }
            : {},
        }),
    });
    return [
      languageSupport,
      EditorView.lineWrapping,
      ViewPlugin.define(
        (view) => ({
          decorations: matcher.createDeco(view),
          update(update) {
            this.decorations = matcher.updateDeco(update, this.decorations);
          },
        }),
        { decorations: (plugin) => plugin.decorations },
      ),
    ];
  }, [template, options]);
  useEffect(() => {
    const view = editor.current?.$view;
    if (!view || editor.current?.getValue() === value) return;
    syncing.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      syncing.current = false;
    }
  }, [value]);
  const insert = (path: string) => {
    const current = editor.current;
    if (!current) return;
    const { from, to } = current.getSelection();
    current.replaceText({ from, to, text: `\${${path}}`, userEvent: "input" });
    // Let the TreeSelect finish its own focus restoration before returning to the cursor.
    requestAnimationFrame(() => {
      if (editor.current === current) current.focus();
    });
  };
  const contents = (full: boolean) => (
    <div className={`workflow-prompt ${full ? "is-expanded" : ""}`}>
      <div className="workflow-prompt-toolbar">
        <span>{template ? "Markdown · 支持变量" : "纯文本 · 不替换变量"}</span>
        {!full && (
          <Button
            type="text"
            size="small"
            icon={<ExpandOutlined />}
            onClick={() => setExpanded(true)}
          >
            展开编辑
          </Button>
        )}
      </div>
      <EditorProvider>
        <Renderer
          plugins={preset}
          extensions={extensions}
          defaultValue={value}
          options={{
            minHeight: full ? 420 : compact ? 120 : 260,
            maxHeight: full ? "60vh" : 420,
            fontSize: 14,
            contentAttributes: {
              "aria-label": label,
              "aria-multiline": "true",
              spellcheck: "false",
            },
            placeholder: compact
              ? "输入文本，可在光标处插入上游变量…"
              : "描述这一步要完成的任务，例如：\n\n# 任务\n根据订单信息生成采购报告。\n\n# 要求\n列出订单状态、金额与资料来源。\n\n# 订单信息\n在这里插入上游变量…",
          }}
          didMount={(api) => {
            editor.current = api;
            const length = api.getValue().length;
            api.$view.dispatch({
              selection: {
                anchor: Math.min(selection.current.from, length),
                head: Math.min(selection.current.to, length),
              },
            });
            if (full) api.focus();
          }}
          onSelectionChange={({ selection: next }) => {
            selection.current = next;
          }}
          onChange={(event) => {
            if (!syncing.current) onChange(event.value);
          }}
        />
      </EditorProvider>
      <div className="workflow-prompt-footer">
        {template ? (
          <WorkflowVariablePicker
            label={`插入${label}变量`}
            placeholder="＋ 在光标处插入变量"
            options={options}
            onChange={insert}
          />
        ) : (
          <span>内容将原样发送</span>
        )}
        <span className={value.length > 16000 ? "workflow-field-error" : ""}>
          {value.length.toLocaleString()} / 16,000
        </span>
      </div>
      {tokens.length > 0 && (
        <div className="workflow-prompt-references">
          <span>已引用</span>
          {tokens.map((path) => (
            <span
              className={`workflow-reference-chip ${options.some((v) => v.value === path && !v.optional) ? "" : "has-error"}`}
              key={path}
              title={path}
            >
              {variableName(path, options)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
  const keyboard: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    if ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || event.key.toLowerCase() === "y") onRedo();
      else onUndo();
    }
  };
  return (
    <div onKeyDownCapture={keyboard}>
      {!expanded && contents(false)}
      <Modal
        title={`${label} · 展开编辑`}
        open={expanded}
        width={920}
        centered
        destroyOnHidden
        onCancel={() => setExpanded(false)}
        footer={
          <Button type="primary" onClick={() => setExpanded(false)}>
            完成编辑
          </Button>
        }
      >
        <p className="workflow-field-help">
          修改同步到当前草稿。用清晰的任务、约束和输出要求组织提示词。
        </p>
        {expanded && contents(true)}
      </Modal>
    </div>
  );
}
