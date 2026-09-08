import {
  EditorRenderer,
  Field,
  FlowNodeVariableData,
  type FormMeta,
  FreeLayoutEditorProvider,
  type FreeLayoutPluginContext,
  type FreeLayoutProps,
  type OperationMeta,
  useNodeRender,
  useWatchFormErrors,
  ValidateTrigger,
  type WorkflowJSON,
  type WorkflowNodeEntity,
  WorkflowNodeRenderer,
  WorkflowOperationBaseService,
} from "@flowgram.ai/free-layout-editor";
import type { WorkflowAssetInput, WorkflowCapability, WorkflowNode } from "@platform/sdk";
import { Drawer } from "antd";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { WorkflowNodeFields } from "./WorkflowFields";
import { autoPositions, connectionIssue, nodeNames, objectSchema } from "./workflow-model";
import {
  scopedWorkflowVariables,
  syncWorkflowVariables,
  type WorkflowVariableOption,
  workflowVariableIssue,
} from "./workflow-variables";
import "@flowgram.ai/free-layout-editor/index.css";
import { createFreeSnapPlugin } from "@flowgram.ai/free-snap-plugin";
import { createMinimapPlugin, MinimapRender } from "@flowgram.ai/minimap-plugin";

const SelectNode = createContext<(id: string) => void>(() => {});
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
    defaultPorts: [
      ...(type === "start" ? [] : [{ type: "input" as const, portID: "in" }]),
      ...(type === "end"
        ? []
        : type === "condition"
          ? [
              { type: "output" as const, portID: "true", locationConfig: { right: 0, top: "62%" } },
              {
                type: "output" as const,
                portID: "false",
                locationConfig: { right: 0, top: "84%" },
              },
            ]
          : [{ type: "output" as const, portID: "out" }]),
    ],
  },
}));
function Card({ node }: { node: WorkflowNodeEntity }) {
  const select = useContext(SelectNode),
    { form, selected } = useNodeRender(node);
  const pointerStart = useRef({ x: 0, y: 0 });
  const type = node.flowNodeType as WorkflowNode["type"];
  const errors = useWatchFormErrors(node);
  const errorCount = Object.values(errors ?? {}).flat().length;
  return (
    <WorkflowNodeRenderer node={node}>
      <button
        type="button"
        className={`workflow-node workflow-node-${type} ${selected ? "selected" : ""}`}
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY };
        }}
        onClick={(event) => {
          if (
            event.detail &&
            Math.hypot(
              event.clientX - pointerStart.current.x,
              event.clientY - pointerStart.current.y,
            ) > 5
          )
            return;
          select(node.id);
        }}
        aria-label={`配置节点 ${String(form?.values.label ?? node.id)}`}
      >
        <span className="workflow-node-kind">{nodeNames[type]}</span>
        {form?.render() ?? <strong>{node.id}</strong>}
        <span className="workflow-node-id">{node.id}</span>
        {!!errorCount && <span className="workflow-field-error">{errorCount} 项配置待修正</span>}
        {type === "condition" && (
          <span className="workflow-branch-labels">
            <span>满足</span>
            <span>不满足</span>
          </span>
        )}
      </button>
    </WorkflowNodeRenderer>
  );
}
function documentFor(value: WorkflowAssetInput): WorkflowJSON {
  const positions = { ...autoPositions(value.definition), ...value.layout };
  return {
    nodes: value.definition.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: structuredClone(n),
      meta: { position: positions[n.id] },
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
  replace(value: WorkflowAssetInput): void;
  fit(): void;
  autoLayout(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  zoom(direction: "in" | "out"): void;
}
type CanvasProps = {
  initial: WorkflowAssetInput;
  onChange(value: WorkflowAssetInput): void;
  onSelect(id: string): void;
  onError?(message: string): void;
  onHistoryChange?(state: { canUndo: boolean; canRedo: boolean }): void;
  catalog?: WorkflowCapability[];
  selected?: string;
  inspector?: boolean;
  onCloseInspector?(): void;
  onDeleteNode?(): void;
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
    const { initial, onSelect, readonly = false } = props;
    const container = useRef<HTMLElement | null>(null);
    const context = useRef<FreeLayoutPluginContext | null>(null);
    const source = useRef(initial);
    const live = useRef(props);
    live.current = props;
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const suppress = useRef(false);
    const [ready, setReady] = useState(false);
    const [options, setOptions] = useState<WorkflowVariableOption[]>([]);
    const [formValid, setFormValid] = useState(true);
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
    const replace = (value: WorkflowAssetInput) => {
      const ctx = context.current;
      if (!ctx) {
        source.current = value;
        return;
      }
      clearTimeout(timer.current);
      suppress.current = true;
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
      } finally {
        ctx.history.endTransaction();
        suppress.current = false;
      }
      notify();
    };
    useImperativeHandle(ref, () => ({
      capture,
      replace,
      fit: () => {
        void context.current?.tools.fitView();
      },
      autoLayout: async () => {
        if (!context.current || live.current.readonly) return;
        await context.current.tools.autoLayout();
        notify();
        await context.current.tools.fitView();
      },
      undo: async () => {
        if (!context.current || live.current.readonly) return;
        await context.current.history.undo();
        notify();
      },
      redo: async () => {
        if (!context.current || live.current.readonly) return;
        await context.current.history.redo();
        notify();
      },
      zoom: (direction) => {
        const config = context.current?.playground.config;
        if (direction === "in") config?.zoomin();
        else config?.zoomout();
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
      let resizeTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(([entry]) => {
        clearTimeout(resizeTimer);
        if (entry.contentRect.width && entry.contentRect.height)
          resizeTimer = setTimeout(() => {
            void context.current?.tools.fitView(false);
          }, 180);
      });
      if (container.current) observer.observe(container.current);
      return () => {
        clearTimeout(resizeTimer);
        observer.disconnect();
      };
    }, []);
    const materials = useMemo(() => ({ renderDefaultNode: Card }), []);
    const editorProps: FreeLayoutProps = {
      initialData,
      nodeRegistries,
      materials,
      readonly,
      background: true,
      nodeEngine: { enable: true },
      variableEngine: { enable: true, layout: "free" },
      history: {
        enable: true,
        enableChangeNode: true,
        disableShortcuts: true,
      },
      plugins: () => [
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
      onAllLayersRendered: (ctx) => {
        context.current = ctx;
        const registration = ctx.history.operationRegistry.registerOperationMeta(metadataOperation);
        ctx.history.onWillDispose(() => registration.dispose());
        ctx.history.clear();
        ctx.history.undoRedoService.onChange(() => {
          live.current.onHistoryChange?.({
            canUndo: ctx.history.canUndo(),
            canRedo: ctx.history.canRedo(),
          });
        });
        setReady(true);
        void ctx.tools.fitView();
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
        live.current.onError?.("请先修正节点名称或无效的固定值");
        return;
      }
      props.onCloseInspector?.();
    };
    return (
      <SelectNode.Provider value={onSelect}>
        <section ref={container} className="workflow-canvas" aria-label="流程画布">
          <FreeLayoutEditorProvider {...editorProps}>
            <EditorRenderer style={{ width: "100%", height: "100%" }} />
            <MinimapRender
              containerStyles={{ position: "absolute", right: 12, bottom: 12, zIndex: 10000 }}
              inactiveStyle={{ scale: 1, opacity: 0.9, translateX: 0, translateY: 0 }}
            />
            <Drawer
              title={
                selectedEntity
                  ? `配置：${String(selectedEntity.form?.values.label ?? selectedEntity.id)}`
                  : "节点配置"
              }
              open={!!props.inspector && !!selectedEntity}
              size="min(440px, 100vw)"
              onClose={closeInspector}
              destroyOnHidden
            >
              {selectedEntity && context.current && (
                <WorkflowNodeFields
                  key={selectedEntity.id}
                  entity={selectedEntity}
                  definition={initial.definition}
                  catalog={props.catalog ?? []}
                  options={options}
                  context={context.current}
                  onClose={closeInspector}
                  onDelete={() => props.onDeleteNode?.()}
                  onValidity={setFormValid}
                />
              )}
            </Drawer>
          </FreeLayoutEditorProvider>
        </section>
      </SelectNode.Provider>
    );
  },
);
