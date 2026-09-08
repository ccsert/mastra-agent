import {
  BranchesOutlined,
  CloseOutlined,
  CodeOutlined,
  EllipsisOutlined,
  FlagOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SearchOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  useClientContext,
  useNodeRender,
  useWatchFormErrors,
  useWatchFormValues,
  type WorkflowNodeEntity,
  WorkflowNodeRenderer,
} from "@flowgram.ai/free-layout-editor";
import type { LineRenderProps } from "@flowgram.ai/free-lines-plugin";
import type { NodePanelRenderProps } from "@flowgram.ai/free-node-panel-plugin";
import type { WorkflowAssetInput, WorkflowCapability, WorkflowNode } from "@platform/sdk";
import { Button, Dropdown, Input, Popover } from "antd";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { AddableNodeType, NodePlacement } from "./workflow-editing";
import { bindingText, nodeNames, objectSchema } from "./workflow-model";

export const nodeDescriptions = {
  start: "定义工作流的输入字段",
  agent: "调用已发布的 Agent，执行模型与工具任务",
  tool: "调用项目内已授权的业务工具",
  map: "提取、映射或组合上游数据",
  condition: "根据条件选择执行路径",
  end: "返回流程结果，结束当前路径",
};
const icons = {
  start: PlayCircleOutlined,
  agent: RobotOutlined,
  tool: ToolOutlined,
  map: CodeOutlined,
  condition: BranchesOutlined,
  end: FlagOutlined,
};
export function NodeIcon({ type }: { type: WorkflowNode["type"] }) {
  const Icon = icons[type];
  return (
    <span className={`workflow-node-icon ${type}`}>
      <Icon />
    </span>
  );
}
interface MaterialsContextValue {
  value: WorkflowAssetInput;
  catalog: WorkflowCapability[];
  readonly: boolean;
  select(id: string): boolean;
  remove(id: string): void;
  duplicate(id: string): void;
  add(position: NodePlacement, anchor?: { x: number; y: number }): void;
}
export const WorkflowMaterialsContext = createContext<MaterialsContextValue | null>(null);
function useMaterials() {
  const ctx = useContext(WorkflowMaterialsContext);
  if (!ctx) throw new Error("Workflow materials require their editor context");
  return ctx;
}
export function WorkflowNodeCard({ node }: { node: WorkflowNodeEntity }) {
  const ctx = useMaterials(),
    editor = useClientContext(),
    { form, selected } = useNodeRender(node);
  const data = useWatchFormValues<WorkflowNode>(node);
  const pointerStart = useRef({ x: 0, y: 0 });
  const errors = useWatchFormErrors(node);
  if (!data) return null;
  const errorCount = Object.values(errors ?? {}).flat().length;
  const entry = ctx.catalog.find(
    (c) =>
      (data.type === "tool" && c.id === data.toolId) ||
      (data.type === "agent" && c.id === data.releaseId),
  );
  const rows: [string, string][] =
    data.type === "start"
      ? Object.entries(objectSchema(ctx.value.definition.inputSchema.properties)).map(
          ([key, schema]) => [key, String(objectSchema(schema).type ?? "any")],
        )
      : data.type === "condition"
        ? [
            [
              "如果",
              `${bindingText(data.left)} ${{ eq: "等于", neq: "不等于", exists: "有值（非 null）", gt: "大于", gte: "大于等于", lt: "小于", lte: "小于等于" }[data.operator]} ${data.right ? bindingText(data.right) : ""}`,
            ],
          ]
        : data.type === "agent"
          ? [
              ["任务", bindingText(data.prompt)],
              ["输出", "text · string"],
            ]
          : Object.entries(data.type === "tool" ? data.input : data.values).map(
              ([key, binding]) => [key, bindingText(binding)],
            );
  return (
    <WorkflowNodeRenderer
      node={node}
      onPortClick={(port, event) => {
        if (ctx.readonly || port.portType !== "output" || typeof event === "function") return;
        const anchor = editor.playground.config.getPosFromMouseEvent(event);
        const edge = ctx.value.definition.edges.find(
          (e) => e.source === node.id && e.port === port.portID,
        );
        ctx.add(
          {
            position: anchor,
            source: node.id,
            port: port.portID as NodePlacement["port"],
            target: edge?.target,
          },
          anchor,
        );
      }}
    >
      <article className={`workflow-node workflow-node-${data.type} ${selected ? "selected" : ""}`}>
        <button
          type="button"
          className="workflow-node-content"
          aria-label={`配置节点 ${data.label}`}
          onPointerDown={(e) => {
            pointerStart.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            if (
              e.detail &&
              Math.hypot(e.clientX - pointerStart.current.x, e.clientY - pointerStart.current.y) > 5
            )
              return;
            if (e.shiftKey) {
              queueMicrotask(() => editor.playground.node.focus());
              return;
            }
            if (!ctx.select(node.id)) e.stopPropagation();
          }}
        >
          <span className="workflow-node-header">
            <NodeIcon type={data.type} />
            <span className="workflow-node-heading">
              {form?.render() ?? <strong>{data.label}</strong>}
              <small>{nodeNames[data.type]}</small>
            </span>
          </span>
          {entry && (
            <span className="workflow-node-resource">
              {entry.name}
              <span>v{entry.version}</span>
            </span>
          )}
          <span className="workflow-node-rows">
            {rows.slice(0, 3).map(([key, value]) => (
              <span className="workflow-node-row" key={key}>
                <span>{key}</span>
                <code title={value}>{value || "待配置"}</code>
              </span>
            ))}
            {!rows.length && (
              <span className="workflow-node-empty">
                {data.type === "tool" ? "配置工具输入" : nodeDescriptions[data.type]}
              </span>
            )}
            {rows.length > 3 && <small>另有 {rows.length - 3} 个字段</small>}
          </span>
          {!!errorCount && <span className="workflow-field-error">{errorCount} 项配置待修正</span>}
          {data.type === "condition" && (
            <span className="workflow-branch-labels">
              <span>满足</span>
              <span>不满足</span>
            </span>
          )}
        </button>
        {!ctx.readonly && (
          <Dropdown
            trigger={["click", "contextMenu"]}
            menu={{
              items: [
                { key: "configure", label: "配置节点" },
                { key: "duplicate", label: "创建副本", disabled: data.type === "start" },
                { type: "divider" },
                { key: "delete", label: "删除节点", danger: true, disabled: data.type === "start" },
              ],
              onClick: ({ key }) =>
                key === "configure"
                  ? ctx.select(node.id)
                  : key === "duplicate"
                    ? ctx.duplicate(node.id)
                    : ctx.remove(node.id),
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<EllipsisOutlined />}
              className="workflow-node-menu"
              aria-label={`${data.label}的节点菜单`}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </Dropdown>
        )}
      </article>
    </WorkflowNodeRenderer>
  );
}
export function WorkflowLineInsert({ line, hovered, selected, color }: LineRenderProps) {
  const ctx = useMaterials();
  // FlowGram may render once more after a history transaction disposes this line.
  if (line.disposed || ctx.readonly || (!hovered && !selected)) return null;
  const { fromPort, toPort } = line;
  if (!fromPort || !toPort) return null;
  return (
    <button
      type="button"
      className="workflow-line-add"
      aria-label={`在${fromPort.node.form?.values.label ?? fromPort.node.id}之后插入节点`}
      style={{
        color,
        transform: `translate(-50%, -50%) translate(${line.center.labelX}px, ${line.center.labelY}px)`,
      }}
      onClick={(e) => {
        e.stopPropagation();
        ctx.add({
          position: {
            x: (line.position.from.x + line.position.to.x) / 2,
            y: (line.position.from.y + line.position.to.y) / 2,
          },
          source: fromPort.node.id,
          target: toPort.node.id,
          port: fromPort.portID as NodePlacement["port"],
        });
      }}
    >
      +
    </button>
  );
}
export const NODE_DRAG_TYPE = "application/x-platform-workflow-node";
export function WorkflowNodePanel({
  position,
  onClose,
  onSelect,
  panelProps,
}: NodePanelRenderProps) {
  const ctx = useClientContext(),
    materials = useMaterials();
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    const focusFrame = requestAnimationFrame(() => ref.current?.querySelector("input")?.focus());
    const scroll = ctx.playground.onScroll(onClose);
    const zoom = ctx.playground.onZoom(onClose);
    return () => {
      document.removeEventListener("keydown", key);
      cancelAnimationFrame(focusFrame);
      scroll.dispose();
      zoom.dispose();
    };
  }, [onClose, ctx.playground]);
  const types: AddableNodeType[] = ["agent", "tool", "map", "condition", "end"];
  const content = (
    <div className="workflow-node-palette" ref={ref} role="dialog" aria-label="添加节点">
      <div className="workflow-panel-heading">
        <strong>
          {panelProps?.target ? "在连线中插入" : panelProps?.source ? "添加下一步" : "添加节点"}
        </strong>
        <Button
          type="text"
          size="small"
          aria-label="关闭节点面板"
          icon={<CloseOutlined />}
          onClick={onClose}
        />
      </div>
      <Input
        aria-label="搜索节点"
        placeholder="搜索节点"
        prefix={<SearchOutlined />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="workflow-palette-hint">点击添加，也可拖到画布空白处</p>
      {types
        .filter((type) =>
          (nodeNames[type] + nodeDescriptions[type]).toLowerCase().includes(query.toLowerCase()),
        )
        .map((type) => {
          const disabled =
            (!!panelProps?.target && type === "end") ||
            ((type === "agent" || type === "tool") &&
              !materials.catalog.some((c) => c.kind === type));
          return (
            <button
              key={type}
              type="button"
              className="workflow-material-item"
              disabled={disabled}
              draggable={!disabled}
              onDragStart={(e) => {
                e.dataTransfer.setData(NODE_DRAG_TYPE, type);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={onClose}
              onClick={(e) => onSelect({ nodeType: type, selectEvent: e })}
            >
              <NodeIcon type={type} />
              <span>
                <strong>{nodeNames[type]}</strong>
                <small>
                  {disabled
                    ? type === "end"
                      ? "请在路径末尾添加"
                      : "项目内尚无可用资源"
                    : nodeDescriptions[type]}
                </small>
              </span>
            </button>
          );
        })}
    </div>
  );
  // The official node-panel layer owns canvas translation and scaling. Anchor the
  // popover to its DOM point; do not convert canvas coordinates into body pixels.
  return (
    <Popover
      open
      trigger="click"
      placement="right"
      align={{ offset: [30, 0] }}
      arrow={false}
      autoAdjustOverflow
      zIndex={1060}
      styles={{ container: { padding: 0 } }}
      content={content}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div
        style={{ position: "absolute", left: position.x, top: position.y, width: 0, height: 0 }}
      />
    </Popover>
  );
}
export const WorkflowPanelContent = createContext<ReactNode>(null);
export function WorkflowSidePanel() {
  return <div className="workflow-side-panel">{useContext(WorkflowPanelContent)}</div>;
}
