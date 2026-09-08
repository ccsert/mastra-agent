import {
  EditorRenderer,
  Field,
  type FormMeta,
  FreeLayoutEditorProvider,
  type FreeLayoutPluginContext,
  type FreeLayoutProps,
  useNodeRender,
  type WorkflowJSON,
  type WorkflowNodeEntity,
  WorkflowNodeRenderer,
} from "@flowgram.ai/free-layout-editor";
import type { WorkflowAssetInput, WorkflowNode } from "@platform/sdk";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { autoPositions, nodeNames } from "./workflow-model";
import "@flowgram.ai/free-layout-editor/index.css";

const SelectNode = createContext<(id: string) => void>(() => {});
const formMeta: FormMeta = {
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
  patchNode(node: WorkflowNode): void;
}
export const WorkflowCanvas = forwardRef<
  WorkflowCanvasHandle,
  {
    initial: WorkflowAssetInput;
    onChange(value: WorkflowAssetInput): void;
    onSelect(id: string): void;
    onError?(message: string): void;
    readonly?: boolean;
  }
>(function WorkflowCanvas({ initial, onChange, onSelect, onError, readonly = false }, ref) {
  const container = useRef<HTMLElement | null>(null);
  const context = useRef<FreeLayoutPluginContext | null>(null),
    source = useRef(initial),
    change = useRef(onChange),
    error = useRef(onError),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    suppress = useRef(false);
  change.current = onChange;
  error.current = onError;
  const initialData = useMemo(() => documentFor(initial), [initial]);
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
    const layout = Object.fromEntries(
      doc.nodes.map((n) => [n.id, n.meta?.position ?? { x: 0, y: 0 }]),
    );
    return {
      ...source.current,
      definition: { ...source.current.definition, nodes, edges },
      layout,
    };
  };
  const replace = (value: WorkflowAssetInput) => {
    clearTimeout(timer.current);
    suppress.current = true;
    source.current = value;
    context.current?.operation.fromJSON(documentFor(value));
    queueMicrotask(() => {
      suppress.current = false;
    });
  };
  useImperativeHandle(ref, () => ({
    capture,
    replace,
    fit: () => {
      void context.current?.tools.fitView();
    },
    patchNode: (node) => {
      const entity = context.current?.document.getNode(node.id);
      if (!entity?.form) throw new Error("节点表单尚未就绪");
      entity.form.updateFormValues(structuredClone(node));
      const next = capture();
      source.current = next;
      change.current(next);
    },
  }));
  useEffect(() => () => clearTimeout(timer.current), []);
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
  const props: FreeLayoutProps = {
    initialData,
    nodeRegistries: registries,
    materials,
    readonly,
    nodeEngine: { enable: true },
    history: { enable: true, disableShortcuts: true },
    onAllLayersRendered: (ctx) => {
      context.current = ctx;
      void ctx.tools.fitView();
    },
    onContentChange: (ctx) => {
      context.current = ctx;
      if (suppress.current || readonly) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        try {
          const value = capture();
          source.current = value;
          change.current(value);
        } catch (e) {
          error.current?.(e instanceof Error ? e.message : "画布数据读取失败");
        }
      }, 250);
    },
  };
  return (
    <SelectNode.Provider value={onSelect}>
      <section ref={container} className="workflow-canvas" aria-label="流程画布">
        <FreeLayoutEditorProvider {...props}>
          <EditorRenderer style={{ width: "100%", height: "100%" }} />
        </FreeLayoutEditorProvider>
      </section>
    </SelectNode.Provider>
  );
});
