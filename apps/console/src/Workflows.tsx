import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckOutlined,
  ExpandOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import type {
  Model,
  WorkflowAsset,
  WorkflowAssetInput,
  WorkflowCapability,
  WorkflowGeneration,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRelease,
  WorkflowRun,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import {
  Alert,
  App as AntApp,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { timestamp, unwrap } from "./api";
import { WorkflowCanvas, type WorkflowCanvasHandle } from "./WorkflowCanvas";
import {
  autoPositions,
  describeChanges,
  emptyWorkflow,
  nodeNames,
  objectSchema,
} from "./workflow-model";
import "./workflows.css";

const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  pending: "待执行",
  skipped: "已跳过",
};
function Status({ value }: { value: string }) {
  return (
    <Tag
      color={
        value === "succeeded"
          ? "success"
          : value === "failed"
            ? "error"
            : value === "running"
              ? "processing"
              : "default"
      }
    >
      {statusNames[value] ?? value}
    </Tag>
  );
}
const draftOf = (asset: WorkflowAsset): WorkflowAssetInput => ({
  name: asset.name,
  description: asset.description,
  definition: asset.definition,
  layout: { ...autoPositions(asset.definition), ...asset.layout },
});
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const normalizedDraft = (value: WorkflowAssetInput) => ({
  ...value,
  definition: {
    ...value.definition,
    nodes: [...value.definition.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...value.definition.edges].sort((a, b) =>
      `${a.source}/${a.port}/${a.target}`.localeCompare(`${b.source}/${b.port}/${b.target}`),
    ),
  },
});
const same = (a: WorkflowAssetInput, b: WorkflowAssetInput) =>
  stable(normalizedDraft(a)) === stable(normalizedDraft(b));
function initialInput(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(objectSchema(schema.properties)).map(([key, value]) => {
      const type = objectSchema(value).type;
      return [
        key,
        type === "number" || type === "integer"
          ? 0
          : type === "boolean"
            ? true
            : type === "array"
              ? []
              : type === "object"
                ? initialInput(objectSchema(value))
                : /order/i.test(key)
                  ? "ORD-1001"
                  : "请生成一份业务报告",
      ];
    }),
  );
}
type RegisterGuard = (guard?: () => "busy" | "dirty" | null) => void;
export function WorkflowWorkspace({
  projectId,
  models,
  registerGuard,
}: {
  projectId: string;
  models: Model[];
  registerGuard: RegisterGuard;
}) {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<WorkflowAsset[]>([]),
    [asset, setAsset] = useState<WorkflowAsset | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [createOpen, setCreateOpen] = useState(false),
    [name, setName] = useState("");
  const path = { projectId };
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await unwrap(api.listWorkflows({ path: { projectId } })));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (asset)
    return (
      <WorkflowEditor
        key={asset.id}
        initial={asset}
        models={models}
        registerGuard={registerGuard}
        onBack={() => {
          setAsset(null);
          void refresh();
        }}
      />
    );
  return (
    <>
      <div className="workflow-intro">
        <div>
          <span className="eyebrow">从业务意图到可重复执行的流程</span>
          <h2>把团队能力组合成工作流</h2>
          <p>用自然语言生成流程，连接 Agent、知识库与业务工具，审阅后发布给团队和业务系统使用。</p>
        </div>
        <div className="workflow-actions">
          <Button
            icon={<ReloadOutlined />}
            aria-label="刷新工作流"
            onClick={() => void refresh()}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setName("");
              setCreateOpen(true);
            }}
          >
            创建工作流
          </Button>
        </div>
      </div>
      {error && <Alert type="error" title={error} />}
      <Spin spinning={loading}>
        {items.length ? (
          <div className="workflow-grid">
            {items.map((item) => (
              <button
                type="button"
                className="workflow-asset-card"
                key={item.id}
                onClick={() => setAsset(item)}
              >
                <span className="workflow-asset-icon">
                  <BranchesOutlined />
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.description || "将 Agent 和业务工具串联为可重复运行的任务。"}</p>
                  <div className="workflow-card-meta">
                    <Tag>{item.publishedVersion ? `已发布 v${item.publishedVersion}` : "草稿"}</Tag>
                    <span>{item.definition.nodes.length} 个节点</span>
                    <span>{timestamp(item.createdAt)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="blank-state">
            <Empty description="还没有工作流">
              <Button onClick={() => setCreateOpen(true)}>从一句业务需求开始</Button>
            </Empty>
          </div>
        )}
      </Spin>
      <Modal
        title="创建工作流"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建并编排"
        onOk={async () => {
          if (!name.trim()) return;
          try {
            const created = await unwrap(
              api.createWorkflow({ path, body: emptyWorkflow(name.trim()) }),
            );
            setCreateOpen(false);
            setAsset(created);
          } catch (e) {
            message.error(e instanceof Error ? e.message : "创建失败");
          }
        }}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Form layout="vertical" component="div">
          <Form.Item label="工作流名称" htmlFor="workflow-create-name" required>
            <Input
              id="workflow-create-name"
              placeholder="例如：订单采购报告"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onPressEnter={() => {
                if (!name.trim()) modal.info({ title: "请输入工作流名称" });
              }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function WorkflowEditor({
  initial,
  models,
  onBack,
  registerGuard,
}: {
  initial: WorkflowAsset;
  models: Model[];
  onBack(): void;
  registerGuard: RegisterGuard;
}) {
  const { message, modal } = AntApp.useApp();
  const [asset, setAsset] = useState(initial),
    [draft, setDraft] = useState(draftOf(initial)),
    [catalog, setCatalog] = useState<WorkflowCapability[]>([]),
    [releases, setReleases] = useState<WorkflowRelease[]>([]),
    [runs, setRuns] = useState<WorkflowRun[]>([]),
    [generations, setGenerations] = useState<WorkflowGeneration[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [issues, setIssues] = useState<{ message: string; nodeId?: string }[]>([]),
    [tab, setTab] = useState("canvas"),
    [selected, setSelected] = useState("start"),
    [inspector, setInspector] = useState(false),
    [settings, setSettings] = useState(false);
  const [settingsName, setSettingsName] = useState(""),
    [settingsDescription, setSettingsDescription] = useState(""),
    [inputSchema, setInputSchema] = useState(""),
    [outputSchema, setOutputSchema] = useState("");
  const [intent, setIntent] = useState(""),
    [modelId, setModelId] = useState(models.find((m) => m.kind === "chat")?.id),
    [review, setReview] = useState<WorkflowGeneration | null>(null);
  const [runOpen, setRunOpen] = useState(false),
    [releaseId, setReleaseId] = useState<string>(),
    [runInput, setRunInput] = useState("{}"),
    [detailId, setDetailId] = useState<string>(),
    [detail, setDetail] = useState<WorkflowRun | null>(null),
    [nodeRuns, setNodeRuns] = useState<WorkflowNodeRun[]>([]);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const canvas = useRef<WorkflowCanvasHandle | null>(null),
    currentDraft = useRef(draft),
    pendingSave = useRef(false);
  currentDraft.current = draft;
  const path = useMemo(
      () => ({ projectId: asset.projectId, id: asset.id }),
      [asset.projectId, asset.id],
    ),
    projectPath = { projectId: asset.projectId };
  const dirty = !same(draft, draftOf(asset)),
    generating = generations.some((g) => g.status === "queued" || g.status === "running");
  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const load = useCallback(async () => {
    const path = { projectId: initial.projectId, id: initial.id };
    const [catalog, releases, runs, generations] = await Promise.all([
      unwrap(api.getWorkflowCatalog({ path: { projectId: initial.projectId } })),
      unwrap(api.listWorkflowReleases({ path })),
      unwrap(api.listWorkflowRuns({ path })),
      unwrap(api.listWorkflowGenerations({ path })),
    ]);
    setCatalog(catalog);
    setReleases(releases);
    setRuns(runs);
    setGenerations(generations);
  }, [initial.id, initial.projectId]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (!generating && !runs.some((r) => r.status === "queued" || r.status === "running")) return;
    let alive = true;
    const timer = setInterval(() => {
      void Promise.all([
        unwrap(api.listWorkflowGenerations({ path })),
        unwrap(api.listWorkflowRuns({ path })),
      ])
        .then(([g, r]) => {
          if (alive) {
            setGenerations(g);
            setRuns(r);
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [generating, runs, path]);
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      setNodeRuns([]);
      return;
    }
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const p = { projectId: initial.projectId, id: detailId };
        const run = await unwrap(api.getWorkflowRun({ path: p }));
        const nodes = await unwrap(api.listWorkflowNodeRuns({ path: p }));
        if (!alive) return;
        setDetail(run);
        setNodeRuns(nodes);
        if (["queued", "running"].includes(run.status)) timer = setTimeout(() => void read(), 800);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "运行详情加载失败");
      }
    };
    void read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [detailId, initial.projectId]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const remember = (next: WorkflowAssetInput, replaceCanvas = true) => {
    if (pendingSave.current || same(next, currentDraft.current)) return;
    if (replaceCanvas) canvas.current?.replace(next);
    setDraft(next);
    currentDraft.current = next;
    setIssues([]);
  };
  const capture = () => canvas.current?.capture() ?? currentDraft.current;
  useEffect(() => {
    registerGuard(() => {
      if (busy || pendingSave.current) return "busy";
      try {
        return same(canvas.current?.capture() ?? currentDraft.current, draftOf(asset))
          ? null
          : "dirty";
      } catch {
        return "dirty";
      }
    });
    return () => registerGuard();
  }, [asset, busy, registerGuard]);
  const save = async () => {
    const next = capture();
    remember(next, false);
    pendingSave.current = true;
    try {
      const saved = await unwrap(
        api.updateWorkflow({ path, body: { ...next, baseRevision: asset.revision } }),
      );
      setAsset(saved);
      const latest = capture();
      const draft = same(latest, next) ? draftOf(saved) : latest;
      setDraft(draft);
      currentDraft.current = draft;
      return saved;
    } finally {
      pendingSave.current = false;
    }
  };
  const history = (direction: "undo" | "redo") => {
    void canvas.current?.[direction]().catch((e) =>
      setError(e instanceof Error ? e.message : "历史操作失败"),
    );
    setIssues([]);
  };
  const historyAction = useRef(history);
  historyAction.current = history;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        busy ||
        tab !== "canvas" ||
        inspector ||
        settings ||
        review ||
        runOpen ||
        detailId ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "z"
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      event.preventDefault();
      historyAction.current(event.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy, tab, inspector, settings, review, runOpen, detailId]);
  const addNode = (type: Exclude<WorkflowNode["type"], "start">) => {
    const current = capture(),
      id = `${type}_${crypto.randomUUID().slice(0, 8)}`;
    if (current.definition.nodes.length + (type === "condition" ? 2 : 1) > 24) {
      message.error("当前流程最多 24 个节点");
      return;
    }
    const entry = catalog.find((c) => c.kind === type);
    if ((type === "tool" || type === "agent") && !entry) {
      message.info(type === "agent" ? "请先发布一个 Agent" : "请先登记只读工具");
      return;
    }
    const outputValues = Object.fromEntries(
      Object.entries(objectSchema(current.definition.outputSchema.properties)).map(
        ([key, schema]) => [
          key,
          {
            kind: "literal" as const,
            value:
              objectSchema(schema).type === "string"
                ? "条件不满足"
                : objectSchema(schema).type === "boolean"
                  ? false
                  : objectSchema(schema).type === "array"
                    ? []
                    : objectSchema(schema).type === "object"
                      ? {}
                      : 0,
          },
        ],
      ),
    );
    const node: WorkflowNode =
      type === "tool"
        ? { id, type, label: "调用业务工具", toolId: entry?.id ?? "", input: {} }
        : type === "agent"
          ? {
              id,
              type,
              label: "Agent 处理",
              releaseId: entry?.id ?? "",
              prompt: { kind: "template", template: `处理以下输入：\${input}` },
            }
          : type === "condition"
            ? {
                id,
                type,
                label: "条件判断",
                left: { kind: "literal", value: true },
                operator: "eq",
                right: { kind: "literal", value: true },
              }
            : {
                id,
                type,
                label: nodeNames[type],
                values: type === "end" ? outputValues : { value: { kind: "ref", path: "input" } },
              };
    const definition = structuredClone(current.definition);
    definition.nodes.push(node);
    const selectedNode = definition.nodes.find((n) => n.id === selected),
      edge =
        selectedNode?.type === "end"
          ? definition.edges.find((e) => e.target === selected)
          : definition.edges.find((e) => e.source === selected && e.port !== "false");
    if (edge && type !== "end") {
      definition.edges = definition.edges.filter((e) => e !== edge);
      definition.edges.push(
        { ...edge, target: id },
        { source: id, target: edge.target, port: type === "condition" ? "true" : "out" },
      );
      if (type === "condition") {
        const endId = `end_${crypto.randomUUID().slice(0, 8)}`;
        definition.nodes.push({
          id: endId,
          type: "end",
          label: "不满足时返回",
          values: outputValues,
        });
        definition.edges.push({ source: id, target: endId, port: "false" });
      }
    }
    remember({
      ...current,
      definition,
      layout: { ...autoPositions(definition), ...current.layout },
    });
    setSelected(id);
    setInspector(true);
    setTimeout(() => canvas.current?.fit(), 50);
  };
  const latestGeneration = generations[0];
  const openRun = (release?: WorkflowRelease) => {
    const selected = release ?? releases[0];
    if (!selected) return;
    setReleaseId(selected.id);
    setRunInput(JSON.stringify(initialInput(selected.snapshot.definition.inputSchema), null, 2));
    setRunOpen(true);
  };
  return (
    <div className="workflow-editor">
      <div className="workflow-editor-heading">
        <div className="workflow-heading-title">
          <Button
            icon={<ArrowLeftOutlined />}
            aria-label="返回工作流列表"
            disabled={busy}
            onClick={() =>
              dirty
                ? modal.confirm({
                    title: "离开未保存的草稿？",
                    content: "当前修改尚未保存，可以先保存后再返回。",
                    okText: "离开",
                    cancelText: "继续编辑",
                    onOk: onBack,
                  })
                : onBack()
            }
          />
          <div>
            <h2>{draft.name}</h2>
            <span className="muted">
              草稿修订 {asset.revision} · {dirty ? "有未保存修改" : "已保存"} ·{" "}
              {asset.publishedVersion ? `已发布 v${asset.publishedVersion}` : "尚未发布"}
            </span>
          </div>
        </div>
        <div className="workflow-actions">
          <Button
            icon={<SaveOutlined />}
            loading={busy}
            onClick={() =>
              void guard(async () => {
                await save();
                message.success("草稿已保存");
              })
            }
          >
            保存
          </Button>
          <Button
            icon={<CheckOutlined />}
            disabled={busy}
            onClick={() =>
              void guard(async () => {
                const saved = await save();
                const result = await unwrap(
                  api.validateWorkflow({ path, body: { baseRevision: saved.revision } }),
                );
                setIssues(result.issues);
                if (!result.issues.length) message.success("图、变量和依赖校验通过");
              })
            }
          >
            校验
          </Button>
          <Button
            disabled={busy || dirty}
            onClick={() =>
              void guard(async () => {
                const release = await unwrap(
                  api.publishWorkflow({ path, body: { baseRevision: asset.revision } }),
                );
                setAsset(await unwrap(api.getWorkflow({ path })));
                await load();
                message.success(`已发布 v${release.version}`);
              })
            }
          >
            发布版本
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={busy || !releases.length}
            onClick={() => openRun()}
          >
            运行
          </Button>
        </div>
      </div>
      {error && <Alert type="error" title={error} closable={{ onClose: () => setError("") }} />}
      {issues.length > 0 && (
        <Alert
          type="error"
          title="流程还不能发布"
          description={
            <ul>
              {issues.map((issue) => (
                <li key={`${issue.nodeId}-${issue.message}`}>
                  <button
                    type="button"
                    className="workflow-issue-link"
                    onClick={() => {
                      if (issue.nodeId) {
                        setSelected(issue.nodeId);
                        setInspector(true);
                      }
                    }}
                  >
                    {issue.nodeId ? `${issue.nodeId}：` : ""}
                    {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          }
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "canvas",
            label: "流程编排",
            forceRender: true,
            children: (
              <div className="workflow-compose">
                <div className="workflow-canvas-area">
                  <div className="workflow-canvas-toolbar">
                    <div className="workflow-actions">
                      {(["tool", "agent", "map", "condition", "end"] as const).map((type) => (
                        <Button
                          size="small"
                          key={type}
                          disabled={busy}
                          onClick={() => addNode(type)}
                        >
                          {nodeNames[type]} +
                        </Button>
                      ))}
                    </div>
                    <div className="workflow-actions">
                      <Button
                        size="small"
                        icon={<UndoOutlined />}
                        aria-label="撤销流程修改"
                        disabled={busy || !historyState.canUndo}
                        onClick={() => history("undo")}
                      />
                      <Button
                        size="small"
                        icon={<RedoOutlined />}
                        aria-label="重做流程修改"
                        disabled={busy || !historyState.canRedo}
                        onClick={() => history("redo")}
                      />
                      <Button
                        size="small"
                        icon={<ApartmentOutlined />}
                        aria-label="自动布局流程"
                        disabled={busy}
                        onClick={() => {
                          void canvas.current?.autoLayout().catch((e) => setError(e.message));
                        }}
                      />
                      <Button
                        size="small"
                        icon={<ZoomInOutlined />}
                        aria-label="放大流程画布"
                        onClick={() => canvas.current?.zoom("in")}
                      />
                      <Button
                        size="small"
                        icon={<ZoomOutOutlined />}
                        aria-label="缩小流程画布"
                        onClick={() => canvas.current?.zoom("out")}
                      />
                      <Button
                        size="small"
                        icon={<ExpandOutlined />}
                        aria-label="适应流程画布"
                        onClick={() => canvas.current?.fit()}
                      />
                      <Button
                        size="small"
                        icon={<SettingOutlined />}
                        aria-label="流程设置"
                        onClick={() => {
                          const value = capture();
                          setSettingsName(value.name);
                          setSettingsDescription(value.description ?? "");
                          setInputSchema(JSON.stringify(value.definition.inputSchema, null, 2));
                          setOutputSchema(JSON.stringify(value.definition.outputSchema, null, 2));
                          setSettings(true);
                        }}
                      />
                    </div>
                  </div>
                  <WorkflowCanvas
                    ref={canvas}
                    initial={draft}
                    readonly={busy}
                    onError={setError}
                    onHistoryChange={setHistoryState}
                    catalog={catalog}
                    selected={selected}
                    inspector={inspector}
                    onCloseInspector={() => setInspector(false)}
                    onDeleteNode={() => {
                      const current = capture();
                      const layout = { ...current.layout };
                      delete layout[selected];
                      remember({
                        ...current,
                        layout,
                        definition: {
                          ...current.definition,
                          nodes: current.definition.nodes.filter((n) => n.id !== selected),
                          edges: current.definition.edges.filter(
                            (e) => e.source !== selected && e.target !== selected,
                          ),
                        },
                      });
                      setInspector(false);
                    }}
                    onChange={(next) => remember(next, false)}
                    onSelect={(id) => {
                      setSelected(id);
                      setInspector(true);
                    }}
                  />
                  <div className="workflow-canvas-foot">
                    拖动节点调整布局 · 从端口拖出连线 · 点击节点配置 · 条件的两条路径独立结束
                  </div>
                </div>
                <aside className="workflow-ai-panel">
                  <div className="workflow-ai-title">
                    <ThunderboltOutlined />
                    <h3>AI 编排助手</h3>
                  </div>
                  <p>描述希望完成的任务，或告诉我如何修改当前流程。</p>
                  <Form layout="vertical" component="div">
                    <Form.Item label="编排模型" htmlFor="workflow-author-model">
                      <Select
                        id="workflow-author-model"
                        value={modelId}
                        options={models
                          .filter((m) => m.kind === "chat")
                          .map((m) => ({ label: m.name, value: m.id }))}
                        onChange={setModelId}
                      />
                    </Form.Item>
                    <Form.Item label="业务需求" htmlFor="workflow-intent">
                      <Input.TextArea
                        id="workflow-intent"
                        value={intent}
                        autoSize={{ minRows: 5, maxRows: 10 }}
                        maxLength={8000}
                        placeholder="输入订单号，查询订单，结合知识库生成带来源的采购报告。"
                        onChange={(e) => setIntent(e.target.value)}
                      />
                    </Form.Item>
                    <Button
                      type="primary"
                      block
                      icon={<ThunderboltOutlined />}
                      loading={generating}
                      disabled={busy || dirty || !modelId || !intent.trim() || generating}
                      onClick={() =>
                        void guard(async () => {
                          const generation = await unwrap(
                            api.generateWorkflow({
                              path,
                              body: {
                                baseRevision: asset.revision,
                                modelId: modelId ?? "",
                                intent,
                                requestId: crypto.randomUUID(),
                              },
                            }),
                          );
                          setGenerations((items) => [generation, ...items]);
                        })
                      }
                    >
                      生成完整候选
                    </Button>
                  </Form>
                  {dirty && (
                    <p className="workflow-hint">先保存当前修改，再让 AI 基于最新草稿编排。</p>
                  )}
                  <p className="workflow-hint">
                    AI 只使用当前项目已有的能力。候选需由你接受，发布后才成为可调用版本。
                  </p>
                  {latestGeneration && (
                    <div className="workflow-generation-card">
                      <div>
                        <strong>最近一次编排</strong>
                        <Status value={latestGeneration.status} />
                      </div>
                      <p className="workflow-generation-intent">{latestGeneration.intent}</p>
                      {latestGeneration.candidate && (
                        <details>
                          <summary>编排说明</summary>
                          <p>{latestGeneration.candidate.explanation}</p>
                        </details>
                      )}
                      {latestGeneration.issues.map((i) => (
                        <p className="workflow-error" key={`${i.nodeId}-${i.message}`}>
                          {i.message}
                        </p>
                      ))}
                      {latestGeneration.errorCode && !latestGeneration.issues.length && (
                        <p className="workflow-error">{latestGeneration.errorCode}</p>
                      )}
                      {latestGeneration.candidate && (
                        <Button block onClick={() => setReview(structuredClone(latestGeneration))}>
                          预览候选与修改
                        </Button>
                      )}
                      {["queued", "running"].includes(latestGeneration.status) && (
                        <Button
                          block
                          onClick={() =>
                            void guard(async () => {
                              await unwrap(
                                api.cancelWorkflowGeneration({
                                  path: { ...projectPath, id: latestGeneration.id },
                                  body: {},
                                }),
                              );
                              await load();
                            })
                          }
                        >
                          取消生成
                        </Button>
                      )}
                    </div>
                  )}
                  {generations.length > 1 && (
                    <details>
                      <summary>历史编排记录（{generations.length}）</summary>
                      {generations.slice(1).map((g) => (
                        <div className="workflow-history-row" key={g.id}>
                          <Status value={g.status} />
                          <Button
                            type="link"
                            disabled={!g.candidate}
                            onClick={() => setReview(structuredClone(g))}
                          >
                            {timestamp(g.createdAt)} · 修订 {g.baseRevision}
                          </Button>
                        </div>
                      ))}
                    </details>
                  )}
                </aside>
              </div>
            ),
          },
          {
            key: "runs",
            label: "运行记录",
            children: (
              <Table
                rowKey="id"
                dataSource={runs}
                scroll={{ x: 650 }}
                columns={[
                  { title: "开始时间", render: (_, r) => timestamp(r.createdAt) },
                  { title: "版本", render: (_, r) => `v${r.version}` },
                  { title: "状态", render: (_, r) => <Status value={r.status} /> },
                  { title: "错误原因", dataIndex: "errorCode", render: (v) => v ?? "—" },
                  {
                    title: "操作",
                    render: (_, r) => (
                      <Button onClick={() => setDetailId(r.id)}>查看节点详情</Button>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "releases",
            label: "发布版本",
            children: (
              <Table
                rowKey="id"
                dataSource={releases}
                scroll={{ x: 650 }}
                columns={[
                  { title: "版本", render: (_, r) => <strong>v{r.version}</strong> },
                  { title: "发布时间", render: (_, r) => timestamp(r.createdAt) },
                  {
                    title: "固定能力",
                    render: (_, r) =>
                      `${r.snapshot.agents.length} 个 Agent · ${r.snapshot.tools.length} 个工具`,
                  },
                  {
                    title: "操作",
                    render: (_, r) => <Button onClick={() => openRun(r)}>运行此版本</Button>,
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        title="流程设置"
        open={settings}
        onCancel={() => setSettings(false)}
        width="min(850px, 96vw)"
        okText="应用设置"
        onOk={() => {
          try {
            const input = JSON.parse(inputSchema),
              output = JSON.parse(outputSchema);
            if (input?.type !== "object" || output?.type !== "object" || !settingsName.trim())
              throw new Error();
            remember({
              ...capture(),
              name: settingsName.trim(),
              description: settingsDescription,
              definition: { ...capture().definition, inputSchema: input, outputSchema: output },
            });
            setSettings(false);
          } catch {
            message.error("名称不能为空，输入输出必须是有效的 object JSON Schema");
          }
        }}
      >
        <Form layout="vertical" component="div">
          <Form.Item label="名称" htmlFor="workflow-settings-name">
            <Input
              id="workflow-settings-name"
              value={settingsName}
              maxLength={80}
              onChange={(e) => setSettingsName(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="说明" htmlFor="workflow-settings-description">
            <Input
              id="workflow-settings-description"
              value={settingsDescription}
              maxLength={500}
              onChange={(e) => setSettingsDescription(e.target.value)}
            />
          </Form.Item>
          <p className="muted">以下契约通常由 AI 自动生成；调整字段后需重新校验引用。</p>
          <div className="workflow-schema-grid">
            <Form.Item label="输入 JSON Schema" htmlFor="workflow-input-schema">
              <Input.TextArea
                id="workflow-input-schema"
                value={inputSchema}
                rows={12}
                onChange={(e) => setInputSchema(e.target.value)}
              />
            </Form.Item>
            <Form.Item label="输出 JSON Schema" htmlFor="workflow-output-schema">
              <Input.TextArea
                id="workflow-output-schema"
                value={outputSchema}
                rows={12}
                onChange={(e) => setOutputSchema(e.target.value)}
              />
            </Form.Item>
          </div>
        </Form>
      </Modal>
      <Modal
        title="审阅 AI 工作流候选"
        open={!!review}
        onCancel={() => setReview(null)}
        width="min(1200px, 96vw)"
        okText={review?.acceptedRevision ? "已接受" : "接受候选"}
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            busy ||
            dirty ||
            review?.status !== "succeeded" ||
            !!review?.acceptedRevision ||
            review?.baseRevision !== asset.revision,
        }}
        onOk={() =>
          void guard(async () => {
            if (!review) return;
            const saved = await unwrap(
              api.acceptWorkflowGeneration({
                path: { ...projectPath, id: review.id },
                body: { baseRevision: review.baseRevision },
              }),
            );
            setAsset(saved);
            const next = draftOf(saved);
            setDraft(next);
            currentDraft.current = next;
            canvas.current?.replace(next);
            setReview(null);
            await load();
            setTimeout(() => canvas.current?.fit(), 50);
            message.success("候选已接受为新草稿，尚未发布");
          })
        }
      >
        {review?.candidate && (
          <div className="workflow-candidate">
            <p>{review.candidate.explanation}</p>
            {review.baseRevision !== asset.revision && (
              <Alert
                type="warning"
                title="当前草稿已变化，此候选不能直接覆盖"
                description="请保留修改，重新基于最新草稿生成候选。"
              />
            )}
            <ul>
              {describeChanges(draft.definition, review.candidate.definition).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <WorkflowCanvas
              key={review.id}
              initial={{
                ...draft,
                definition: review.candidate.definition,
                layout: autoPositions(review.candidate.definition),
              }}
              onChange={() => {}}
              onSelect={() => {}}
              catalog={catalog}
              readonly
            />
            <details>
              <summary>查看节点、变量与资源的完整变更</summary>
              <div className="workflow-schema-grid">
                <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
                <pre>{JSON.stringify(review.candidate.definition, null, 2)}</pre>
              </div>
            </details>
          </div>
        )}
      </Modal>
      <Modal
        title="运行已发布工作流"
        open={runOpen}
        onCancel={() => setRunOpen(false)}
        okText="开始执行"
        confirmLoading={busy}
        okButtonProps={{ disabled: !releaseId || busy }}
        onOk={() =>
          void guard(async () => {
            const input = JSON.parse(runInput);
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new Error("运行输入必须为 JSON 对象");
            const run = await unwrap(
              api.createWorkflowRun({
                path,
                body: { releaseId: releaseId ?? "", input, requestId: crypto.randomUUID() },
              }),
            );
            setRunOpen(false);
            setDetailId(run.id);
            setRuns((runs) => [run, ...runs]);
          })
        }
      >
        <Form layout="vertical" component="div">
          <Form.Item label="发布版本" htmlFor="workflow-run-version">
            <Select
              id="workflow-run-version"
              value={releaseId}
              options={releases.map((r) => ({
                label: `v${r.version} · ${timestamp(r.createdAt)}`,
                value: r.id,
              }))}
              onChange={(id) => {
                setReleaseId(id);
                const r = releases.find((r) => r.id === id);
                if (r)
                  setRunInput(
                    JSON.stringify(initialInput(r.snapshot.definition.inputSchema), null, 2),
                  );
              }}
            />
          </Form.Item>
          <Form.Item
            label="运行输入"
            htmlFor="workflow-run-input"
            extra="预填值是合成样例，请按业务任务调整。"
          >
            <Input.TextArea
              id="workflow-run-input"
              value={runInput}
              rows={8}
              onChange={(e) => setRunInput(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title="工作流运行详情"
        open={!!detailId}
        onClose={() => setDetailId(undefined)}
        size="min(920px, 100vw)"
        destroyOnHidden
      >
        {detail ? (
          <>
            <div className="workflow-run-summary">
              <div>
                <h3>{detail.name}</h3>
                <span className="muted">
                  v{detail.version} · {timestamp(detail.createdAt)}
                </span>
              </div>
              <Status value={detail.status} />
              {["queued", "running"].includes(detail.status) && (
                <Button
                  danger
                  onClick={() =>
                    void guard(async () => {
                      await unwrap(
                        api.cancelWorkflowRun({
                          path: { ...projectPath, id: detail.id },
                          body: {},
                        }),
                      );
                      await load();
                    })
                  }
                >
                  取消运行
                </Button>
              )}
            </div>
            {detail.errorCode && <Alert type="error" title={`运行停止：${detail.errorCode}`} />}
            {detail.output && (
              <section className="workflow-result">
                <h3>执行结果</h3>
                <div className="workflow-report">
                  {typeof detail.output.report === "string" ? (
                    <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]}>
                      {detail.output.report.trim()}
                    </Markdown>
                  ) : (
                    <pre>{JSON.stringify(detail.output, null, 2)}</pre>
                  )}
                </div>
              </section>
            )}
            <div className="workflow-node-timeline">
              {nodeRuns.map((node) => (
                <details className={`workflow-node-record ${node.status}`} key={node.nodeId}>
                  <summary>
                    <span>
                      <strong>{node.label}</strong>
                      <small>{nodeNames[node.type as WorkflowNode["type"]] ?? node.type}</small>
                    </span>
                    <Status value={node.status} />
                  </summary>
                  {node.errorCode && <p className="workflow-error">{node.errorCode}</p>}
                  <div className="workflow-schema-grid">
                    <div>
                      <h4>输入</h4>
                      <pre>{JSON.stringify(node.input, null, 2)}</pre>
                    </div>
                    <div>
                      <h4>输出</h4>
                      <pre>{JSON.stringify(node.output, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <details>
              <summary>调用信息</summary>
              <pre>
                {JSON.stringify(
                  {
                    workflowId: asset.id,
                    releaseId: detail.releaseId,
                    runId: detail.id,
                    input: detail.input,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        ) : (
          <Spin />
        )}
      </Drawer>
    </div>
  );
}
