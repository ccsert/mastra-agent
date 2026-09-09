import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  CheckOutlined,
  ExpandOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import type { Model, WorkflowAsset, WorkflowAssetInput, WorkflowRelease } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, App as AntApp, Button, Tabs } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { unwrap } from "../api";
import { useProjectQuery, useProjectRefresh } from "../data/ProjectData";
import { PageMore, pageItems } from "../data/pages";
import { QueryState } from "../data/QueryState";
import { workflowQueries } from "../data/workflows";
import { useLifetime } from "../useLifetime";
import { useOperation } from "../useOperation";
import { WorkflowCanvas, type WorkflowCanvasHandle } from "../WorkflowCanvas";
import { draftOf, type RegisterGuard, same } from "./draft";
import { WorkflowAuthoring } from "./WorkflowAuthoring";
import { WorkflowReleases, WorkflowRuns } from "./WorkflowRecords";
import { WorkflowRunDetails } from "./WorkflowRunDetails";
import { WorkflowRunDialog } from "./WorkflowRunDialog";
import { WorkflowSettings } from "./WorkflowSettings";
export function WorkflowEditor({
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
  const lifetime = useLifetime(),
    refresh = useProjectRefresh();
  const { busy, error, setError, run: guard } = useOperation();
  const [asset, setAsset] = useState(initial),
    [draft, setDraft] = useState(draftOf(initial));
  const catalogQuery = useProjectQuery("workflowCatalog"),
    catalog = catalogQuery.data ?? [];
  const releasesQuery = useInfiniteQuery(workflowQueries.releases(initial.projectId, initial.id)),
    releases = pageItems(releasesQuery.data);
  const [issues, setIssues] = useState<{ message: string; nodeId?: string }[]>([]),
    [tab, setTab] = useState("canvas"),
    [selected, setSelected] = useState("start"),
    [inspector, setInspector] = useState(false),
    [settings, setSettings] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [runRelease, setRunRelease] = useState<WorkflowRelease | null>(null),
    [detailId, setDetailId] = useState<string>();
  const [nodeValid, setNodeValid] = useState(true);
  const [aiOpen, setAiOpen] = useState(false),
    [zoom, setZoom] = useState(1);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const canvas = useRef<WorkflowCanvasHandle | null>(null),
    currentDraft = useRef(draft),
    pendingSave = useRef(false);
  currentDraft.current = draft;
  const path = useMemo(
    () => ({ projectId: asset.projectId, id: asset.id }),
    [asset.projectId, asset.id],
  );
  const dirty = !nodeValid || !same(draft, draftOf(asset));
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const remember = (next: WorkflowAssetInput) => {
    if (pendingSave.current || same(next, currentDraft.current)) return;
    setDraft(next);
    currentDraft.current = next;
    setIssues([]);
  };
  const capture = () => canvas.current?.capture() ?? currentDraft.current;
  useEffect(() => {
    registerGuard(() => {
      if (busy || pendingSave.current) return "busy";
      try {
        if (canvas.current && !canvas.current.canLeaveNode()) return "dirty";
        return same(canvas.current?.capture() ?? currentDraft.current, draftOf(asset))
          ? null
          : "dirty";
      } catch {
        return "dirty";
      }
    });
    return () => registerGuard();
  }, [asset, busy, registerGuard]);
  const save = async (signal: AbortSignal) => {
    if (canvas.current && !canvas.current.canLeaveNode())
      throw new Error("请先修正节点中尚未完成的输入");
    const next = capture();
    remember(next);
    pendingSave.current = true;
    try {
      const saved = await unwrap(
        api.updateWorkflow({ path, body: { ...next, baseRevision: asset.revision }, signal }),
        signal,
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
        settings ||
        reviewing ||
        runRelease ||
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
  }, [busy, tab, settings, reviewing, runRelease, detailId]);
  return (
    <div className="workflow-editor">
      <div className="workflow-editor-heading">
        <div className="workflow-heading-title">
          <Button
            icon={<ArrowLeftOutlined />}
            aria-label="返回工作流列表"
            disabled={busy}
            onClick={() =>
              dirty || !canvas.current?.canLeaveNode()
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
              {dirty ? "未保存" : "已保存"} · 修订 {asset.revision} ·{" "}
              {asset.publishedVersion ? `已发布 v${asset.publishedVersion}` : "尚未发布"}
            </span>
          </div>
        </div>
        <div className="workflow-actions">
          <Button
            icon={<SaveOutlined />}
            loading={busy}
            onClick={() =>
              void guard(async (signal) => {
                await save(signal);
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
              void guard(async (signal) => {
                const saved = await save(signal);
                const result = await unwrap(
                  api.validateWorkflow({ path, body: { baseRevision: saved.revision }, signal }),
                  signal,
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
              void guard(async (signal) => {
                if (!canvas.current?.canLeaveNode()) return;
                const release = await unwrap(
                  api.publishWorkflow({ path, body: { baseRevision: asset.revision }, signal }),
                  signal,
                );
                setAsset(await unwrap(api.getWorkflow({ path, signal }), signal));
                void refresh("workflows");
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
            onClick={() => setRunRelease(releases[0] ?? null)}
          >
            运行已发布版本
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
                      if (issue.nodeId && canvas.current?.canLeaveNode()) {
                        setAiOpen(false);
                        setSelected(issue.nodeId);
                        setInspector(true);
                        canvas.current.focus(issue.nodeId);
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
                      <Button
                        icon={<PlusOutlined />}
                        disabled={busy}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          canvas.current?.openNodePanel({
                            clientX: rect.left,
                            clientY: rect.bottom + 12,
                          });
                        }}
                      >
                        添加节点
                      </Button>
                      <Button
                        icon={<ThunderboltOutlined />}
                        type={aiOpen ? "primary" : "default"}
                        disabled={busy}
                        onClick={() => {
                          if (!canvas.current?.canLeaveNode()) return;
                          setInspector(false);
                          setAiOpen(!aiOpen);
                        }}
                      >
                        AI 编排
                      </Button>
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
                        className="workflow-zoom-value"
                        aria-label="恢复 100% 缩放"
                        onClick={() => canvas.current?.zoom("reset")}
                      >
                        {Math.round(zoom * 100)}%
                      </Button>
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
                          if (!canvas.current?.canLeaveNode()) return;
                          setSettings(true);
                        }}
                      />
                    </div>
                  </div>
                  <QueryState label="可用能力" query={catalogQuery}>
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
                      onZoomChange={setZoom}
                      onValidityChange={setNodeValid}
                      onInitialized={(next) => {
                        setDraft(next);
                        currentDraft.current = next;
                      }}
                      panel={
                        aiOpen
                          ? {
                              title: "AI 编排助手",
                              content: (
                                <WorkflowAuthoring
                                  asset={asset}
                                  draft={draft}
                                  catalog={catalog}
                                  models={models}
                                  dirty={dirty}
                                  busy={busy}
                                  guard={guard}
                                  onReviewChange={setReviewing}
                                  onAccepted={async (saved, signal) => {
                                    const next = draftOf(saved);
                                    setAsset(saved);
                                    await canvas.current?.replace(next);
                                    signal.throwIfAborted();
                                    const laidOut = canvas.current?.capture() ?? next;
                                    setDraft(laidOut);
                                    currentDraft.current = laidOut;
                                    canvas.current?.fit();
                                  }}
                                />
                              ),
                              onClose: () => {
                                if (!busy) setAiOpen(false);
                              },
                            }
                          : undefined
                      }
                      onChange={remember}
                      onSelect={(id) => {
                        setSelected(id);
                        setInspector(true);
                        setAiOpen(false);
                      }}
                    />
                  </QueryState>
                  <div className="workflow-canvas-foot">
                    <span>
                      {draft.definition.nodes.length} 个节点 · {draft.definition.edges.length}{" "}
                      条连线
                    </span>
                    <span>空格拖动画布 · ⌘ / Ctrl + C、V 复制粘贴 · Delete 删除</span>
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: "runs",
            label: "运行记录",
            children: (
              <WorkflowRuns
                projectId={asset.projectId}
                id={asset.id}
                enabled={tab === "runs"}
                onDetail={setDetailId}
              />
            ),
          },
          {
            key: "releases",
            label: "发布版本",
            children: (
              <WorkflowReleases
                projectId={asset.projectId}
                id={asset.id}
                enabled={tab === "releases"}
                onRun={setRunRelease}
              />
            ),
          },
        ]}
      />
      {settings && (
        <WorkflowSettings
          initial={draft}
          onClose={() => setSettings(false)}
          onApply={async (value) => {
            const signal = lifetime(),
              editor = canvas.current;
            if (!editor?.canLeaveNode()) throw new Error("请等待布局完成或修正节点输入");
            await editor.replace({
              ...capture(),
              name: value.name,
              description: value.description,
              definition: {
                ...capture().definition,
                inputSchema: value.inputSchema,
                outputSchema: value.outputSchema,
              },
            });
            signal.throwIfAborted();
            remember(editor.capture());
          }}
        />
      )}
      {runRelease && (
        <WorkflowRunDialog
          projectId={asset.projectId}
          workflowId={asset.id}
          initialRelease={runRelease}
          releases={releases}
          pagination={<PageMore query={releasesQuery} count={releases.length} label="版本" />}
          onClose={() => setRunRelease(null)}
          onStarted={(run) => {
            setRunRelease(null);
            setDetailId(run.id);
          }}
        />
      )}
      {detailId && (
        <WorkflowRunDetails
          key={detailId}
          projectId={asset.projectId}
          workflowId={asset.id}
          id={detailId}
          onClose={() => setDetailId(undefined)}
        />
      )}
    </div>
  );
}
