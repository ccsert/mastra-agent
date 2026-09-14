import {
  ArrowLeftOutlined,
  BookOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  RocketOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { Agent, AgentPreview } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Form, Modal, Tag } from "antd";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { timestamp, unwrap } from "../../shared/api";
import {
  projectKey,
  useProjectQuery,
  useProjectRefresh,
  useStorageScope,
} from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { readSessionValue, writeSessionValue } from "../../shared/data/session-storage";
import type { EditorCallbacks } from "../../shared/EditorForm";
import {
  type PageAction,
  usePageActionReadiness,
  usePageActionTargets,
} from "../../shared/PageActions";
import { useOperation } from "../../shared/useOperation";
import { ChatSession } from "../chat/index";
import { AgentFields, type AgentSection } from "./AgentFields";
import { type AgentValues, agentBody, agentValues, changedSections } from "./agent-form";

const sections = [
  { key: "purpose", label: "用途与指令", icon: <ThunderboltOutlined />, note: "目标、行为与模型" },
  { key: "knowledge", label: "知识与技能", icon: <BookOutlined />, note: "资料与工作方法" },
  { key: "tools", label: "工具", icon: <ToolOutlined />, note: "可执行的业务动作" },
  { key: "runtime", label: "运行设置", icon: <SettingOutlined />, note: "计划、协作与预算" },
  { key: "releases", label: "发布记录", icon: <HistoryOutlined />, note: "正式版本与变更" },
] satisfies { key: AgentSection; label: string; icon: ReactNode; note: string }[];

const previewKey = (storageScope: string | undefined, id?: string) =>
  storageScope && id ? `${storageScope}:agent-preview:${id}` : undefined;
const restorePreview = (storageScope: string | undefined, id?: string) => {
  const value = readSessionValue(previewKey(storageScope, id));
  if (
    !value ||
    typeof value !== "object" ||
    !("conversationId" in value) ||
    !("releaseId" in value) ||
    !("draftRevision" in value)
  )
    return undefined;
  if (
    typeof value.conversationId !== "string" ||
    typeof value.releaseId !== "string" ||
    typeof value.draftRevision !== "number"
  )
    return undefined;
  return {
    conversationId: value.conversationId,
    releaseId: value.releaseId,
    draftRevision: value.draftRevision,
  };
};

export function AgentEditor({
  projectId,
  agent,
  onSaved,
  onClose,
  onCreated,
  registerGuard,
  canEdit = true,
  canPublish = true,
}: EditorCallbacks & {
  projectId: string;
  agent?: Agent;
  onCreated?(agent: Agent): void;
  registerGuard?(guard?: () => "busy" | "dirty" | null): void;
  canEdit?: boolean;
  canPublish?: boolean;
}) {
  const [form] = Form.useForm<AgentValues>(),
    { message, modal } = App.useApp(),
    refresh = useProjectRefresh();
  const storageScope = useStorageScope();
  const [saved, setSaved] = useState(agent),
    [dirty, setDirty] = useState(false),
    [section, setSection] = useState<AgentSection>("purpose");
  const [preview, setPreview] = useState<AgentPreview | undefined>(() =>
      restorePreview(storageScope, agent?.id),
    ),
    [previewOpen, setPreviewOpen] = useState(true),
    [previewRunning, setPreviewRunning] = useState(false);
  const [publishing, setPublishing] = useState<Agent>();
  const savedRef = useRef(saved),
    initialized = useRef<string | undefined>(undefined);
  const { busy, error, setError, run } = useOperation();
  const modelsQuery = useProjectQuery("models"),
    toolsQuery = useProjectQuery("tools"),
    knowledgeQuery = useProjectQuery("knowledgeBases"),
    skillsQuery = useProjectQuery("skills");
  const ready = [modelsQuery, toolsQuery, knowledgeQuery, skillsQuery].every(
    (q) => q.data !== undefined && !q.error,
  );
  usePageActionReadiness(ready);
  const values: AgentValues = Form.useWatch([], form) ?? agentValues(saved);
  usePageActionTargets(
    canEdit && ready && !busy && !previewRunning
      ? [
          {
            id: "agent.section",
            label: "Agent 配置分区",
            kind: "select",
            value: section,
            options: sections.map((s) => s.key),
            execute: (value) => {
              const next = sections.find((s) => s.key === value);
              if (!next) throw new Error("配置分区不存在");
              setSection(next.key);
            },
          },
          ...(section === "purpose"
            ? (["name", "description", "instructions"] as const).map(
                (field): PageAction => ({
                  id: `agent.${field}`,
                  label: { name: "Agent 名称", description: "简短描述", instructions: "行为指令" }[
                    field
                  ],
                  kind: "fill",
                  value: String(values[field] ?? ""),
                  execute: (value) => {
                    if (value === undefined) throw new Error("缺少字段值");
                    form.setFieldValue(field, value);
                    setDirty(true);
                  },
                }),
              )
            : []),
        ]
      : [],
  );
  const guardState = useRef({ busy: false, dirty: false });
  guardState.current = { busy: busy || previewRunning, dirty };
  useEffect(() => {
    registerGuard?.(() =>
      guardState.current.busy ? "busy" : guardState.current.dirty ? "dirty" : null,
    );
    return () => registerGuard?.();
  }, [registerGuard]);
  useEffect(() => {
    const id = agent?.id ?? "new";
    if (
      initialized.current === id ||
      (agent?.id && savedRef.current?.id === agent.id && initialized.current !== undefined)
    )
      return;
    initialized.current = id;
    savedRef.current = agent;
    setSaved(agent);
    setDirty(false);
    setPreview(restorePreview(storageScope, agent?.id));
    setSection("purpose");
    form.resetFields();
    form.setFieldsValue(agentValues(agent));
  }, [agent, form, storageScope]);
  const releases = useQuery({
    queryKey: projectKey(projectId, "agents", saved?.id ?? "new", "releases"),
    queryFn: ({ signal }) =>
      unwrap(api.listReleases({ path: { projectId, id: saved?.id ?? "" }, signal })),
    enabled: !!saved?.id,
  });
  const latest = releases.data?.[0];
  async function perform(action: "save" | "preview" | "publish") {
    if (!canEdit || !ready || busy || previewRunning) return;
    let body: AgentValues;
    try {
      body = agentBody(await form.validateFields());
    } catch (e) {
      const fields = e as { errorFields?: { name: (string | number)[] }[] },
        name = fields.errorFields?.[0]?.name[0];
      setSection(
        name === "toolIds"
          ? "tools"
          : name === "skillBindings" || name === "knowledgeBaseIds"
            ? "knowledge"
            : ["maxSteps", "executionLimits", "delegation"].includes(String(name))
              ? "runtime"
              : "purpose",
      );
      return;
    }
    let createdAgent: Agent | undefined;
    await run(async (signal) => {
      let current = savedRef.current;
      const created = !current;
      if (!current || dirty) {
        current = await unwrap(
          current
            ? api.updateAgent({
                path: { projectId, id: current.id },
                body: { ...body, baseRevision: current.draftRevision },
                signal,
              })
            : api.createAgent({ path: { projectId }, body, signal }),
        );
        signal.throwIfAborted();
        savedRef.current = current;
        setSaved(current);
        form.setFieldsValue(agentValues(current));
        setDirty(false);
        if (created) createdAgent = current;
        await refresh("agents");
        onSaved();
      }
      if (action === "preview") {
        const result = await unwrap(
          api.previewAgent({
            path: { projectId, id: current.id },
            body: { baseRevision: current.draftRevision, requestId: uuid() },
            signal,
          }),
        );
        signal.throwIfAborted();
        setPreview(result);
        writeSessionValue(previewKey(storageScope, current.id), result);
        setPreviewOpen(true);
      } else if (action === "publish") {
        if (canPublish) setPublishing(current);
      } else void message.success("草稿已保存");
    });
    if (createdAgent) {
      initialized.current = createdAgent.id;
      guardState.current = { busy: false, dirty: false };
      onCreated?.(createdAgent);
    }
  }
  const previewStale = !!preview && (dirty || saved?.draftRevision !== preview.draftRevision);
  return (
    <div className={`agent-authoring${previewOpen ? " with-preview" : ""}`}>
      <header className="agent-authoring-toolbar">
        <div className="agent-authoring-title">
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            aria-label="返回 Agents"
            onClick={onClose}
          />
          <div>
            <h1>{saved?.name ?? "创建 Agent"}</h1>
            <span>
              {dirty
                ? "有未保存的修改"
                : saved
                  ? `草稿 r${saved.draftRevision} · 已保存`
                  : "从用途开始，逐步补充能力"}
            </span>
          </div>
          <Tag>{latest ? `已发布 v${latest.version}` : "未发布"}</Tag>
          {!canEdit && <Tag>只读</Tag>}
        </div>
        <div className="agent-toolbar-actions">
          <Button icon={<ExperimentOutlined />} onClick={() => setPreviewOpen((v) => !v)}>
            {previewOpen ? "收起试用" : "显示试用"}
          </Button>
          {canEdit && (
            <>
              <Button
                aria-label="保存草稿"
                icon={<SaveOutlined />}
                disabled={!ready || previewRunning}
                loading={busy}
                onClick={() => void perform("save")}
              >
                保存草稿
              </Button>
              <Button
                type="primary"
                aria-label={canPublish ? "发布" : "需管理员发布"}
                icon={<RocketOutlined />}
                disabled={!ready || previewRunning || !canPublish || busy}
                onClick={() => void perform("publish")}
              >
                {canPublish ? "发布" : "需管理员发布"}
              </Button>
            </>
          )}
        </div>
      </header>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          closable={{ onClose: () => setError("") }}
          action={
            saved && (
              <Button
                disabled={busy || previewRunning}
                onClick={() => {
                  modal.confirm({
                    title: "读取最新草稿？",
                    content: "这会丢弃当前表单中未保存的修改。已开始的试用仍保留原草稿。",
                    okText: "读取最新草稿",
                    cancelText: "保留修改",
                    onOk: () =>
                      run(async (signal) => {
                        const agents = await unwrap(
                          api.listAgents({ path: { projectId }, signal }),
                        );
                        const current = agents.find((item) => item.id === saved.id);
                        if (!current) throw new Error("Agent 不存在或当前身份无权访问");
                        signal.throwIfAborted();
                        savedRef.current = current;
                        setSaved(current);
                        form.resetFields();
                        form.setFieldsValue(agentValues(current));
                        setDirty(false);
                        await refresh("agents");
                      }),
                  });
                }}
              >
                读取最新草稿
              </Button>
            )
          }
        />
      )}
      <div className="agent-authoring-body">
        <nav className="agent-config-nav" aria-label="Agent 配置导航">
          {sections.map((item) => (
            <button
              type="button"
              key={item.key}
              aria-current={section === item.key ? "step" : undefined}
              onClick={() => setSection(item.key)}
            >
              {item.icon}
              <span>
                <strong>{item.label}</strong>
                <small>{item.note}</small>
              </span>
            </button>
          ))}
          <div className="agent-config-guidance">
            <strong>配置 → 试用 → 发布</strong>
            <p>先验证草稿效果，准备好后再交给团队使用。</p>
          </div>
        </nav>
        <div className="agent-config-content">
          <QueryState label="模型服务" query={modelsQuery}>
            {null}
          </QueryState>
          <QueryState label="工具" query={toolsQuery}>
            {null}
          </QueryState>
          <QueryState label="知识库" query={knowledgeQuery}>
            {null}
          </QueryState>
          <QueryState label="Skill 版本" query={skillsQuery}>
            {null}
          </QueryState>
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            disabled={!ready || busy || !canEdit}
            onValuesChange={() => setDirty(true)}
          >
            <AgentFields
              section={section}
              form={form}
              values={values}
              models={modelsQuery.data ?? []}
              tools={toolsQuery.data ?? []}
              knowledge={knowledgeQuery.data ?? []}
              newAgent={!saved}
              changed={() => setDirty(true)}
              canPublish={canPublish}
            />
          </Form>
          {section === "releases" && (
            <section className="agent-config-section">
              <header>
                <span className="agent-section-kicker">05 / 发布记录</span>
                <h2>团队正在使用哪个版本？</h2>
                <p>新会话使用最新正式版本，已有会话保留原来的配置。</p>
              </header>
              {saved ? (
                <QueryState label="发布记录" query={releases}>
                  {!releases.data?.length && (
                    <Alert type="info" title="尚未发布，可以先在右侧验证草稿。" />
                  )}
                  {releases.data?.map((release, index) => (
                    <article className="agent-release-item" key={release.id}>
                      <div>
                        <strong>v{release.version}</strong>
                        {index === 0 && <Tag color="success">当前正式版本</Tag>}
                        <time>{timestamp(release.createdAt)}</time>
                      </div>
                      <p>
                        {release.snapshot.agent.name} · {release.snapshot.model.name}
                      </p>
                      <small>
                        {release.snapshot.tools.length} 个工具 ·{" "}
                        {release.snapshot.knowledgeBases?.length ?? 0} 个知识库 ·{" "}
                        {release.snapshot.skills?.length ?? 0} 个 Skill
                      </small>
                      <p className="form-note">
                        {changedSections(
                          release.snapshot.agent,
                          releases.data?.[index + 1]?.snapshot.agent,
                        ).join("、") || "依赖配置更新"}
                      </p>
                    </article>
                  ))}
                </QueryState>
              ) : (
                <Alert type="info" title="保存第一个草稿后，在这里管理发布版本。" />
              )}
            </section>
          )}
        </div>
        <aside hidden={!previewOpen} className="agent-preview" aria-label="草稿试用">
          <header>
            <div>
              <ExperimentOutlined />
              <strong>草稿试用</strong>
              <Tag>{preview ? `r${preview.draftRevision}` : "尚未开始"}</Tag>
            </div>
            <Button
              size="small"
              disabled={!ready || !canEdit || previewRunning || busy}
              onClick={() => void perform("preview")}
            >
              {preview ? "重新试用" : "保存并试用"}
            </Button>
          </header>
          {previewStale && (
            <Alert
              banner
              type="warning"
              title="配置已变化，当前对话仍使用原草稿。重新试用以验证最新修改。"
            />
          )}
          {preview ? (
            <div className="agent-preview-chat">
              <ChatSession
                key={preview.conversationId}
                conversationId={preview.conversationId}
                onRunningChange={setPreviewRunning}
              />
            </div>
          ) : (
            <div className="agent-preview-empty">
              <span>
                <ExperimentOutlined />
              </span>
              <h3>在这里验证实际效果</h3>
              <p>保存当前配置后，发一个真实问题，查看回答、工具调用和执行结果。</p>
              <Button
                type="primary"
                disabled={!ready || !canEdit}
                loading={busy}
                onClick={() => void perform("preview")}
              >
                保存并开始试用
              </Button>
              <small>试用会计入模型用量，配置尚未正式发布。</small>
            </div>
          )}
        </aside>
      </div>
      <Modal
        title="发布前确认"
        open={!!publishing}
        onCancel={() => setPublishing(undefined)}
        okText="发布正式版本"
        confirmLoading={busy}
        okButtonProps={{ disabled: releases.isFetching || !!releases.error }}
        onOk={() => {
          if (!publishing || !canPublish) return;
          const target = publishing;
          void run(async (signal) => {
            const release = await unwrap(
              api.publishAgent({
                path: { projectId, id: target.id },
                body: { baseRevision: target.draftRevision },
                signal,
              }),
            );
            signal.throwIfAborted();
            setPublishing(undefined);
            await Promise.all([refresh("agents"), releases.refetch()]);
            void message.success(`已发布 v${release.version}，新会话将使用此版本`);
          });
        }}
      >
        <p>发布后，团队和获准的业务应用可使用这份配置。</p>
        <QueryState label="发布对比" query={releases}>
          {null}
        </QueryState>
        <div className="agent-publish-summary">
          <strong>本次变更</strong>
          <ul>
            {changedSections(agentBody(publishing ?? values), latest?.snapshot.agent).map(
              (label) => (
                <li key={label}>{label}</li>
              ),
            )}
          </ul>
          {!changedSections(agentBody(publishing ?? values), latest?.snapshot.agent).length && (
            <p>Agent 配置与上次一致，发布时会重新检查依赖配置。</p>
          )}
          <p>模型：{modelsQuery.data?.find((m) => m.id === publishing?.modelId)?.name ?? "—"}</p>
          <p>
            {publishing?.toolIds.length ?? 0} 个工具 · {publishing?.knowledgeBaseIds?.length ?? 0}{" "}
            个知识库 · {publishing?.skillBindings?.length ?? 0} 个固定 Skill 版本
          </p>
        </div>
        <Alert
          type="info"
          title="已有会话继续使用原版本"
          description="草稿试用不会转成正式会话。发布时会重新检查权限、模型兼容性和所有能力引用。"
        />
      </Modal>
    </div>
  );
}
