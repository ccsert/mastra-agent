import { TreeSelect } from "antd";
import { useMemo } from "react";
import type { WorkflowVariableOption } from "./workflow-variables";

interface VariableTreeItem {
  value: string;
  label: string;
  title: React.ReactNode;
  disabled: boolean;
  children: VariableTreeItem[];
}
/** Adapt the official AntD material's scoped tree to the platform's string-path contract. */
export function WorkflowVariablePicker({
  options,
  value,
  label,
  onChange,
}: {
  options: WorkflowVariableOption[];
  value?: string;
  label: string;
  onChange(path: string): void;
}) {
  const treeData = useMemo(() => {
    const entries = new Map<string, VariableTreeItem>();
    for (const option of options) {
      const root = option.value === "input" || /^nodes\.[^.]+$/.test(option.value);
      const name = root
        ? option.label.split(" · ")[0]
        : (option.value.split(".").at(-1) ?? option.value);
      entries.set(option.value, {
        value: option.value,
        label: `${name} ${option.value} ${option.type}`,
        title: (
          <span className="workflow-variable-option">
            <span>{name}</span>
            <small>
              {option.type}
              {option.optional ? " · 可空" : ""}
            </small>
          </span>
        ),
        disabled: option.optional,
        children: [],
      });
    }
    const roots: VariableTreeItem[] = [];
    for (const [path, item] of entries) {
      const parent = entries.get(path.slice(0, path.lastIndexOf(".")));
      if (parent) parent.children.push(item);
      else roots.push(item);
    }
    return roots;
  }, [options]);
  return (
    <TreeSelect
      aria-label={label}
      value={value}
      placeholder="选择上游节点的变量"
      treeData={treeData}
      treeDefaultExpandAll
      showSearch={{
        filterTreeNode: (input, node) =>
          String(node.label).toLowerCase().includes(input.toLowerCase()),
      }}
      treeNodeLabelProp="value"
      styles={{ popup: { root: { maxWidth: "calc(100vw - 32px)", minWidth: 280 } } }}
      notFoundContent="当前节点暂无可引用的上游变量"
      onChange={onChange}
    />
  );
}
