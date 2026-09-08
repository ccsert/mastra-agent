import { CloseOutlined } from "@ant-design/icons";
import {
  EditorRenderer,
  Field,
  FlowNodeVariableData,
  type FormMeta,
  FreeLayoutEditorProvider,
  type FreeLayoutPluginContext,
  type FreeLayoutProps,
  type OperationMeta,
  ValidateTrigger,
  WorkflowDragService,
  type WorkflowJSON,
  WorkflowLineEntity,
  WorkflowLinesManager,
  WorkflowNodeEntity,
  WorkflowOperationBaseService,
} from "@flowgram.ai/free-layout-editor";
import { createFreeLinesPlugin } from "@flowgram.ai/free-lines-plugin";
import {
  createFreeNodePanelPlugin,
  WorkflowNodePanelService,
  WorkflowNodePanelUtils,
} from "@flowgram.ai/free-node-panel-plugin";
import {
  createPanelManagerPlugin,
  DockedPanelLayer,
  PanelManager,
} from "@flowgram.ai/panel-manager-plugin";
import type { WorkflowAssetInput, WorkflowCapability, WorkflowNode } from "@platform/sdk";
import { Button } from "antd";
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { WorkflowNodeFields } from "./WorkflowFields";
import {
  NODE_DRAG_TYPE,
  NodeIcon,
  WorkflowLineInsert,
  WorkflowMaterialsContext,
  WorkflowNodeCard,
  WorkflowNodePanel,
  WorkflowPanelContent,
  WorkflowSidePanel,
} from "./WorkflowMaterials";
import {
  type AddableNodeType,
  insertWorkflowNode,
  type NodePlacement,
  pasteWorkflowNodes,
} from "./workflow-editing";
import { connectionIssue, needsWorkflowLayout, nodeNames, objectSchema } from "./workflow-model";
import {
  scopedWorkflowVariables,
  syncWorkflowVariables,
  type WorkflowVariableOption,
  workflowVariableIssue,
} from "./workflow-variables";
import "@flowgram.ai/free-layout-editor/index.css";
import { createFreeSnapPlugin } from "@flowgram.ai/free-snap-plugin";
import { createMinimapPlugin, MinimapRender } from "@flowgram.ai/minimap-plugin";

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
function documentFor(value: WorkflowAssetInput): WorkflowJSON {
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
export interface WorkflowCanvasHandle {
  capture(): WorkflowAssetInput;
  replace(value: WorkflowAssetInput): Promise<void>;
  fit(): void;
  autoLayout(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  zoom(direction: "in" | "out" | "reset"): void;
  openNodePanel(position: { clientX: number; clientY: number }): void;
  focus(id: string): void;
  canLeaveNode(): boolean;
}
type CanvasProps = {
  initial: WorkflowAssetInput;
  onChange(value: WorkflowAssetInput): void;
  onInitialized?(value: WorkflowAssetInput): void;
  onSelect(id: string): void;
  onError?(message: string): void;
  onHistoryChange?(state: { canUndo: boolean; canRedo: boolean }): void;
  catalog?: WorkflowCapability[];
  selected?: string;
  inspector?: boolean;
  onCloseInspector?(): void;
  panel?: { title: string; content: ReactNode; onClose(): void };
  onZoomChange?(zoom: number): void;
  onValidityChange?(valid: boolean): void;
  readonly?: boolean;
};
type WorkflowMetadata = Pick<WorkflowAssetInput, "name" | "description"> &
  Pick<WorkflowAssetInput["definition"], "inputSchema" | "outputSchema">;
const metadataOf = (value: WorkflowAssetInput): WorkflowMetadata => ({
  name: value.name,
  description: value.description,
  inputSchema: value.definition.inputSchema,
  outputSchema: value.definition.outputSchema,
});
export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, CanvasProps>(
  function WorkflowCanvas(props, ref) {
    const { initial, readonly = false } = props;
    const container = useRef<HTMLElement | null>(null);
    const context = useRef<FreeLayoutPluginContext | null>(null);
    const source = useRef(initial);
    const live = useRef(props);
    live.current = props;
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const suppress = useRef(false);
    const [ready, setReady] = useState(false);
    const [layoutBusy, setLayoutBusy] = useState(false);
    const panelOpen = useRef(false);
    const [options, setOptions] = useState<WorkflowVariableOption[]>([]);
    const [formValid, setFormValid] = useState(true);
    const formValidRef = useRef(true);
    formValidRef.current = formValid;
    useEffect(() => {
      live.current.onValidityChange?.(formValid);
    }, [formValid]);
    const clipboard = useRef<WorkflowAssetInput | null>(null);
    const pasteOffset = useRef(48);
    const initialData = useMemo(() => documentFor(initial), [initial]);
    const nodeRegistries = useMemo(
      () =>
        registries.map((registry) => ({
          ...registry,
          formMeta: {
            ...formMeta,
            validate: (values: WorkflowNode) => {
              const validators: NonNullable<FormMeta["validate"]> = {
                label: ({ value }) =>
                  typeof value === "string" && value.trim() ? undefined : "请输入节点名称",
              };
              const entry = live.current.catalog?.find(
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
                    if (!context.current) continue;
                    const issue = workflowVariableIssue(context.current, values.id, path, optional);
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
                      ? source.current.definition.outputSchema
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
        })),
      [],
    );
    const capture = (): WorkflowAssetInput => {
      if (!context.current) return source.current;
      const doc = context.current.document.toJSON();
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
        ...source.current,
        definition: { ...source.current.definition, nodes, edges },
        layout: Object.fromEntries(
          doc.nodes.map((n) => [n.id, n.meta?.position ?? { x: 0, y: 0 }]),
        ),
      };
    };
    const notify = () => {
      clearTimeout(timer.current);
      if (!context.current || suppress.current) return;
      try {
        const value = capture();
        if (
          live.current.selected &&
          !value.definition.nodes.some((n) => n.id === live.current.selected)
        )
          live.current.onCloseInspector?.();
        source.current = value;
        live.current.onChange(value);
        live.current.onHistoryChange?.({
          canUndo: context.current.history.canUndo(),
          canRedo: context.current.history.canRedo(),
        });
      } catch (e) {
        live.current.onError?.(e instanceof Error ? e.message : "画布数据读取失败");
      }
    };
    const metadataOperation: OperationMeta<{ before: WorkflowMetadata; after: WorkflowMetadata }> =
      {
        type: "platform.workflow.metadata",
        inverse: (op) => ({ ...op, value: { before: op.value.after, after: op.value.before } }),
        apply: ({ value }) => {
          const { inputSchema, outputSchema, ...meta } = structuredClone(value.after);
          source.current = {
            ...source.current,
            ...meta,
            definition: { ...source.current.definition, inputSchema, outputSchema },
          };
        },
        shouldMerge: () => false,
      };
    const replace = async (
      value: WorkflowAssetInput,
      afterRender?: () => void,
      autoLayout = false,
    ) => {
      const ctx = context.current;
      if (!ctx) {
        source.current = value;
        return;
      }
      if (suppress.current) throw new Error("请等待流程布局完成");
      clearTimeout(timer.current);
      suppress.current = true;
      setLayoutBusy(true);
      ctx.history.startTransaction();
      try {
        const before = metadataOf(source.current),
          after = metadataOf(value);
        if (JSON.stringify(before) !== JSON.stringify(after))
          ctx.history.pushOperation({ type: metadataOperation.type, value: { before, after } });
        // This is the public service watched by 1.0.15's position history plugin.
        ctx
          .get<WorkflowOperationBaseService>(WorkflowOperationBaseService)
          .fromJSON(documentFor(value));
        if (autoLayout || needsWorkflowLayout(value) || afterRender) {
          await WorkflowNodePanelUtils.waitNodeRender();
          if (autoLayout || needsWorkflowLayout(value))
            await ctx.tools.autoLayout({ disableFitView: true, enableAnimation: false });
          else afterRender?.();
        }
      } finally {
        ctx.history.endTransaction();
        suppress.current = false;
        setLayoutBusy(false);
      }
      notify();
    };
    const focus = (id: string) => {
      const ctx = context.current,
        node = ctx?.document.getNode(id);
      if (ctx && node)
        void ctx.playground.scrollToView({
          bounds: node.transform.bounds,
          zoom: Math.max(ctx.playground.config.zoom, 0.85),
          scrollToCenter: true,
        });
    };
    const select = (id: string, updateSelection = false) => {
      if (!formValidRef.current && live.current.inspector && id !== live.current.selected) {
        live.current.onError?.("请先修正当前节点的无效输入");
        return false;
      }
      const ctx = context.current,
        node = ctx?.document.getNode(id);
      if (updateSelection && ctx && node) ctx.selection.selection = [node];
      live.current.onSelect(id);
      queueMicrotask(() => ctx?.playground.node.focus());
      return true;
    };
    const add = async (type: AddableNodeType, placement: NodePlacement) => {
      const ctx = context.current;
      if (!ctx || live.current.readonly || suppress.current || !formValidRef.current) return;
      try {
        const fromPort = placement.source
          ? ctx.document
              .getNode(placement.source)
              ?.ports.getPortEntityByKey("output", placement.port)
          : undefined;
        const toPort = placement.target
          ? ctx.document.getNode(placement.target)?.ports.getPortEntityByKey("input", "in")
          : undefined;
        const position = WorkflowNodePanelUtils.adjustNodePosition({
          nodeType: type,
          position:
            fromPort && !toPort
              ? { x: placement.position.x + 100, y: placement.position.y }
              : placement.position,
          fromPort,
          toPort,
          document: ctx.document,
          dragService: ctx.get(WorkflowDragService),
        });
        const { next, id } = insertWorkflowNode(
          capture(),
          type,
          { ...placement, position },
          live.current.catalog ?? [],
        );
        await replace(
          next,
          fromPort && toPort
            ? () => {
                if (!placement.source || !placement.target) return;
                const node = ctx.document.getNode(id);
                const from = ctx.document
                  .getNode(placement.source)
                  ?.ports.getPortEntityByKey("output", placement.port);
                const to = ctx.document
                  .getNode(placement.target)
                  ?.ports.getPortEntityByKey("input", "in");
                if (node && from && to)
                  WorkflowNodePanelUtils.subNodesAutoOffset({
                    node,
                    fromPort: from,
                    toPort: to,
                    historyService: ctx.history,
                    dragService: ctx.get(WorkflowDragService),
                    linesManager: ctx.get(WorkflowLinesManager),
                  });
              }
            : undefined,
          // Local offset only considers one edge. A fork needs Dagre to keep
          // the new node clear of its sibling branch and both output ports.
          fromPort?.node.flowNodeType === "condition",
        );
        select(id, true);
      } catch (e) {
        live.current.onError?.(e instanceof Error ? e.message : "添加节点失败");
      }
    };
    const openPanel = async (placement: NodePlacement, panelPosition = placement.position) => {
      const ctx = context.current;
      if (!ctx || live.current.readonly || suppress.current || panelOpen.current) return;
      if (!formValidRef.current) {
        live.current.onError?.("请先修正当前节点的无效输入");
        return;
      }
      panelOpen.current = true;
      try {
        const result = await ctx
          .get(WorkflowNodePanelService)
          .singleSelectNodePanel({ position: panelPosition, panelProps: placement });
        if (result && ["agent", "tool", "condition", "map", "end"].includes(result.nodeType))
          await add(result.nodeType as AddableNodeType, placement);
      } finally {
        panelOpen.current = false;
      }
    };
    const remove = (id?: string) => {
      const ctx = context.current;
      if (!ctx || live.current.readonly || suppress.current) return;
      const selection = id ? [ctx.document.getNode(id)] : [...ctx.selection.selection];
      ctx.history.startTransaction();
      try {
        for (const entity of selection) {
          if (
            entity instanceof WorkflowNodeEntity &&
            entity.flowNodeType !== "start" &&
            ctx.document.canRemove(entity)
          )
            entity.dispose();
          else if (
            entity instanceof WorkflowLineEntity &&
            ctx.document.linesManager.canRemove(entity)
          )
            entity.dispose();
        }
        ctx.selection.selection = ctx.selection.selection.filter((e) => !e.disposed);
      } finally {
        ctx.history.endTransaction();
      }
      notify();
      if (live.current.selected && !ctx.document.getNode(live.current.selected))
        live.current.onCloseInspector?.();
    };
    const copy = (id?: string) => {
      const ctx = context.current;
      if (!ctx) return;
      const ids = id
        ? [id]
        : ctx.selection.selection.filter((e) => e instanceof WorkflowNodeEntity).map((e) => e.id);
      const value = capture();
      value.definition.nodes = value.definition.nodes.filter(
        (n) => ids.includes(n.id) && n.type !== "start",
      );
      value.definition.edges = value.definition.edges.filter(
        (e) =>
          value.definition.nodes.some((n) => n.id === e.source) &&
          value.definition.nodes.some((n) => n.id === e.target),
      );
      if (value.definition.nodes.length) {
        clipboard.current = value;
        pasteOffset.current = 48;
      }
    };
    const paste = async () => {
      if (!clipboard.current || live.current.readonly || suppress.current || !formValidRef.current)
        return;
      try {
        const { next, ids } = pasteWorkflowNodes(capture(), clipboard.current, pasteOffset.current);
        pasteOffset.current += 48;
        await replace(next);
        const ctx = context.current;
        if (ctx)
          ctx.selection.selection = ids.flatMap((id) => {
            const node = ctx.document.getNode(id);
            return node ? [node] : [];
          });
      } catch (e) {
        live.current.onError?.(e instanceof Error ? e.message : "粘贴失败");
      }
    };
    useImperativeHandle(ref, () => ({
      capture,
      replace,
      focus,
      canLeaveNode: () => {
        if (suppress.current || !ready) {
          live.current.onError?.("请等待流程布局完成");
          return false;
        }
        if (!formValidRef.current) live.current.onError?.("请先修正当前节点的无效输入");
        return formValidRef.current;
      },
      openNodePanel: (event) => {
        const ctx = context.current;
        if (!ctx) return;
        const bounds = ctx.playground.node.getBoundingClientRect();
        const center = ctx.playground.config.getPosFromMouseEvent({
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
        });
        void openPanel(
          { position: { x: center.x - 140, y: center.y - 80 } },
          ctx.playground.config.getPosFromMouseEvent(event),
        );
      },
      fit: () => {
        void context.current?.tools.fitView();
      },
      autoLayout: async () => {
        if (!context.current || live.current.readonly || suppress.current) return;
        suppress.current = true;
        setLayoutBusy(true);
        try {
          await context.current.tools.autoLayout();
        } finally {
          suppress.current = false;
          setLayoutBusy(false);
          notify();
        }
      },
      undo: async () => {
        if (!context.current || live.current.readonly || suppress.current) return;
        await context.current.history.undo();
        notify();
      },
      redo: async () => {
        if (!context.current || live.current.readonly || suppress.current) return;
        await context.current.history.redo();
        notify();
      },
      zoom: (direction) => {
        const config = context.current?.playground.config;
        if (direction === "in") config?.zoomin();
        else if (direction === "out") config?.zoomout();
        else config?.updateZoom(1, false);
      },
    }));
    useEffect(() => () => clearTimeout(timer.current), []);
    useEffect(() => {
      if (!ready || !context.current) return;
      syncWorkflowVariables(context.current, initial.definition, props.catalog ?? []);
      const scope = props.selected
        ? context.current.document.getNode(props.selected)?.getData(FlowNodeVariableData).public
        : undefined;
      const refresh = () =>
        setOptions(
          props.selected && context.current
            ? scopedWorkflowVariables(context.current, props.selected)
            : [],
        );
      refresh();
      for (const node of context.current.document.getAllNodes()) void node.form?.validate();
      const subscription = scope?.available.onListOrAnyVarChange(refresh);
      return () => subscription?.dispose();
    }, [ready, initial.definition, props.catalog, props.selected]);
    useEffect(() => {
      if (!ready || !context.current) return;
      const manager = context.current.get(PanelManager);
      if ((props.inspector && props.selected) || props.panel) {
        if (!manager.getPanels().some((p) => p.key === "workflow-side"))
          manager.open("workflow-side", "docked-right");
      } else manager.close("workflow-side");
    }, [ready, props.inspector, props.selected, props.panel]);
    const materials = useMemo(() => ({ renderDefaultNode: WorkflowNodeCard }), []);
    const editorProps: FreeLayoutProps = {
      initialData,
      nodeRegistries,
      materials,
      readonly,
      background: true,
      playground: { preventGlobalGesture: true },
      nodeEngine: { enable: true },
      variableEngine: { enable: true, layout: "free" },
      history: {
        enable: true,
        enableChangeNode: true,
        disableShortcuts: true,
      },
      shortcuts: (registry, ctx) => {
        const safe = (action: () => void) => () => {
          if (
            live.current.readonly ||
            !container.current?.getClientRects().length ||
            document.activeElement?.closest(
              "input, textarea, select, [contenteditable=true], [role=dialog]",
            )
          )
            return;
          action();
        };
        registry.addHandlers(
          {
            commandId: "workflow.copy",
            shortcuts: ["meta c", "ctrl c"],
            execute: safe(() => copy()),
          },
          { commandId: "workflow.paste", shortcuts: ["meta v", "ctrl v"], execute: safe(paste) },
          {
            commandId: "workflow.select-all",
            shortcuts: ["meta a", "ctrl a"],
            execute: safe(() => {
              ctx.selection.selection = ctx.document.getAllNodes();
            }),
          },
          {
            commandId: "workflow.delete",
            shortcuts: ["backspace", "delete"],
            execute: safe(() => remove()),
          },
        );
      },
      plugins: () => [
        createFreeLinesPlugin({ renderInsideLine: WorkflowLineInsert }),
        createFreeNodePanelPlugin({ renderer: WorkflowNodePanel }),
        createPanelManagerPlugin({
          factories: [
            {
              key: "workflow-side",
              defaultSize: 480,
              minSize: 400,
              maxSize: 720,
              render: () => <WorkflowSidePanel />,
            },
          ],
          autoResize: false,
          getPopupContainer: (ctx) => ctx.playground.node.parentElement ?? document.body,
        }),
        createFreeSnapPlugin({ enableGridSnapping: true, enableEdgeSnapping: true, gridSize: 16 }),
        createMinimapPlugin({
          disableLayer: true,
          canvasClassName: "workflow-minimap",
          canvasStyle: { canvasWidth: 160, canvasHeight: 100, nodeColor: "#4c8b76" },
        }),
      ],
      canDeleteNode: (_ctx, node) => node.flowNodeType !== "start",
      canAddLine: (_ctx, from, to, _lines, silent) => {
        const output = from.portType === "output" ? from : to;
        const input = from.portType === "input" ? from : to;
        const doc = capture().definition;
        const reason = connectionIssue(doc, output.node.id, input.node.id, String(output.portID));
        if (reason && !silent) live.current.onError?.(reason);
        return !reason;
      },
      onDragLineEnd: async (_ctx, params) => {
        if (
          params.originLine ||
          !params.line ||
          params.toPort ||
          params.fromPort?.portType !== "output"
        )
          return;
        await openPanel({
          position: params.mousePos,
          source: params.fromPort.node.id,
          port: params.fromPort.portID as NodePlacement["port"],
        });
      },
      onAllLayersRendered: (ctx) => {
        context.current = ctx;
        clearTimeout(timer.current);
        suppress.current = true;
        setLayoutBusy(true);
        const registration = ctx.history.operationRegistry.registerOperationMeta(metadataOperation);
        ctx.history.onWillDispose(() => registration.dispose());
        ctx.history.undoRedoService.onChange(() => {
          live.current.onHistoryChange?.({
            canUndo: ctx.history.canUndo(),
            canRedo: ctx.history.canRedo(),
          });
        });
        const zoomSubscription = ctx.playground.onZoom((zoom) => live.current.onZoomChange?.(zoom));
        ctx.history.onWillDispose(() => zoomSubscription.dispose());
        live.current.onZoomChange?.(ctx.playground.config.zoom);
        const initialize = async () => {
          try {
            if (needsWorkflowLayout(source.current)) {
              await WorkflowNodePanelUtils.waitNodeRender();
              await ctx.tools.autoLayout({ disableFitView: true, enableAnimation: false });
            }
            source.current = capture();
            live.current.onInitialized?.(source.current);
            ctx.history.clear();
            await ctx.tools.fitView(false);
            setReady(true);
          } catch (e) {
            live.current.onError?.(e instanceof Error ? e.message : "流程初始化失败");
          } finally {
            suppress.current = false;
            setLayoutBusy(false);
          }
        };
        void initialize();
        const selection = ctx.selection.onSelectionChanged(() => {
          if (suppress.current || !formValidRef.current || !live.current.inspector) return;
          const nodes = ctx.selection.selection.filter(
            (entity) => entity instanceof WorkflowNodeEntity,
          );
          if (nodes.length === 1 && nodes[0].id !== live.current.selected)
            live.current.onSelect(nodes[0].id);
        });
        ctx.history.onWillDispose(() => selection.dispose());
      },
      onContentChange: (ctx) => {
        context.current = ctx;
        if (suppress.current) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(notify, 120);
      },
    };
    const selectedEntity = props.selected
      ? context.current?.document.getNode(props.selected)
      : undefined;
    const closeInspector = () => {
      if (!formValid) {
        live.current.onError?.("请先修正节点配置中的错误");
        return;
      }
      props.onCloseInspector?.();
    };
    const panelContent = props.panel ? (
      <>
        <div className="workflow-panel-heading">
          <strong>{props.panel.title}</strong>
          <Button
            type="text"
            aria-label="关闭侧栏"
            icon={<CloseOutlined />}
            onClick={props.panel.onClose}
          />
        </div>
        {props.panel.content}
      </>
    ) : selectedEntity && context.current ? (
      <>
        <div className="workflow-panel-heading">
          <NodeIcon type={selectedEntity.flowNodeType as WorkflowNode["type"]} />
          <strong>{nodeNames[selectedEntity.flowNodeType as WorkflowNode["type"]]}配置</strong>
          <Button
            type="text"
            aria-label="关闭节点配置"
            icon={<CloseOutlined />}
            onClick={closeInspector}
          />
        </div>
        <WorkflowNodeFields
          key={selectedEntity.id}
          entity={selectedEntity}
          definition={initial.definition}
          catalog={props.catalog ?? []}
          options={options}
          context={context.current}
          onClose={closeInspector}
          onDelete={() => remove(selectedEntity.id)}
          onValidity={setFormValid}
        />
      </>
    ) : null;
    return (
      <WorkflowMaterialsContext.Provider
        value={{
          value: initial,
          catalog: props.catalog ?? [],
          readonly: readonly || layoutBusy,
          select,
          remove,
          duplicate: (id) => {
            copy(id);
            paste();
          },
          add: (placement, anchor) => {
            void openPanel(placement, anchor);
          },
        }}
      >
        <WorkflowPanelContent.Provider value={panelContent}>
          <section
            ref={container}
            className="workflow-canvas"
            aria-label="流程画布"
            aria-busy={!ready || layoutBusy}
          >
            <FreeLayoutEditorProvider {...editorProps}>
              <DockedPanelLayer style={{ width: "100%", height: "100%" }}>
                <div
                  className="workflow-playground"
                  role="application"
                  aria-label="工作流编辑画布"
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(NODE_DRAG_TYPE)) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                    }
                  }}
                  onDrop={(e) => {
                    const type = e.dataTransfer.getData(NODE_DRAG_TYPE);
                    if (
                      !["agent", "tool", "map", "condition", "end"].includes(type) ||
                      !context.current
                    )
                      return;
                    e.preventDefault();
                    add(type as AddableNodeType, {
                      position: context.current.playground.config.getPosFromMouseEvent(e),
                    });
                  }}
                >
                  <EditorRenderer style={{ width: "100%", height: "100%" }} />
                  <MinimapRender
                    containerStyles={{ position: "absolute", right: 16, bottom: 16, zIndex: 10000 }}
                    inactiveStyle={{ scale: 1, opacity: 0.9, translateX: 0, translateY: 0 }}
                  />
                </div>
              </DockedPanelLayer>
            </FreeLayoutEditorProvider>
            {(!ready || layoutBusy) && (
              <div className="workflow-layout-pending" role="status">
                正在整理流程布局…
              </div>
            )}
          </section>
        </WorkflowPanelContent.Provider>
      </WorkflowMaterialsContext.Provider>
    );
  },
);
