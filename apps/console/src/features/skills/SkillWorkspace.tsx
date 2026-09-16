import { FileZipOutlined, SyncOutlined } from "@ant-design/icons";
import type { SkillImportPreview, SkillVersion } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Space, Tabs, Tag } from "antd";
import { useState } from "react";
import { useProjectAccess } from "../../shared/access";
import { timestamp, unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import {
  projectKey,
  useProjectId,
  useProjectPages,
  useProjectRefresh,
} from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import type { ResourceSelection } from "../../shared/navigation";
import { usePageActionTargets } from "../../shared/PageActions";
import { useOperation } from "../../shared/useOperation";
import { SystemCapabilityDirectory } from "../capabilities/index";
import { SkillFileTree } from "./SkillFileTree";
import { SkillImport } from "./SkillImport";

function sourceLabel(skill: SkillVersion) {
  if (!skill.source) return "历史导入";
  return skill.source.kind === "zip"
    ? "ZIP 导入"
    : `${skill.source.repository} · ${skill.source.commit.slice(0, 8)}`;
}
function SkillDetails({
  skill,
  onClose,
  onUpdate,
}: {
  skill: SkillVersion;
  onClose(): void;
  onUpdate(preview: SkillImportPreview): void;
}) {
  const projectId = useProjectId(),
    refresh = useProjectRefresh(),
    { message } = App.useApp();
  const { run, busy, error } = useOperation();
  const access = useProjectAccess();
  const canManage = access?.permissions.includes("resource.manage") ?? false;
  const canEdit = access?.permissions.includes("resource.edit") ?? false;
  const [path, setPath] = useState("SKILL.md");
  const query = useQuery({
    queryKey: projectKey(projectId, "skills", skill.id, "file", path),
    queryFn: ({ signal }) =>
      unwrap(api.getSkillFile({ path: { projectId, id: skill.id }, query: { path }, signal })),
    gcTime: 0,
  });
  const file = skill.files.find((f) => f.path === path);
  const bytes = query.data
    ? Uint8Array.from(atob(query.data.contentBase64), (c) => c.charCodeAt(0))
    : null;
  const download = () => {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes]));
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").at(-1) ?? "skill-file";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Drawer
      title={
        <Space size={8}>
          <FileZipOutlined />
          {skill.name}
          <Tag>v{skill.version}</Tag>
          <Tag>项目自定义</Tag>
        </Space>
      }
      open
      onClose={onClose}
      size="min(1120px, 100vw)"
    >
      <div className="skill-detail">
        {error && <Alert type="error" title={error} />}
        <div className="skill-detail-head">
          <div className="skill-detail-head-meta">
            <Tag color={skill.enabled ? "success" : "default"}>
              {skill.enabled ? "可绑定" : "已停用"}
            </Tag>
            <span>{sourceLabel(skill)}</span>
            <span>登记于 {timestamp(skill.createdAt)}</span>
            {skill.compatibility && <span>环境要求：{skill.compatibility}</span>}
          </div>
          <Space wrap>
            {canEdit && skill.source && skill.source.kind !== "zip" && (
              <Button
                icon={<SyncOutlined />}
                aria-label="检查上游更新"
                loading={busy}
                onClick={() =>
                  void run(async (signal) => {
                    onUpdate(
                      await unwrap(
                        api.previewSkillUpdate({
                          path: { projectId, id: skill.id },
                          body: {},
                          signal,
                        }),
                        signal,
                      ),
                    );
                  })
                }
              >
                检查上游更新
              </Button>
            )}
            <Button
              disabled={!canManage}
              title={canManage ? undefined : "版本启停需要项目管理员权限"}
              danger={skill.enabled}
              loading={busy}
              onClick={() =>
                void run(async (signal) => {
                  await unwrap(
                    api.setSkillAccess({
                      path: { projectId, id: skill.id },
                      body: { enabled: !skill.enabled },
                      signal,
                    }),
                    signal,
                  );
                  await refresh("skills");
                  signal.throwIfAborted();
                  message.success(
                    skill.enabled
                      ? "版本已停用，后续访问会被拒绝，进行中的调用将在授权检查后停止"
                      : "版本已启用",
                  );
                  onClose();
                })
              }
            >
              {skill.enabled ? "停用此版本" : "启用此版本"}
            </Button>
          </Space>
        </div>
        {skill.warnings.map((warning) => (
          <Alert key={warning} type="warning" title={warning} className="form-alert" />
        ))}
        <p className="skill-detail-desc">{skill.description}</p>
        <dl>
          <dt>绑定权限</dt>
          <dd>
            {access?.permissions.includes("agent.edit")
              ? "可在 Agent 草稿中绑定已启用版本；脚本入口需单独授权"
              : "当前角色可以查看内容，不能修改 Agent 绑定"}
          </dd>
          <dt>助手使用</dt>
          <dd>平台助手可按需阅读内容，包内脚本不会自动执行。</dd>
          <dt>管理权限</dt>
          <dd>
            {canManage
              ? "可以启停版本"
              : canEdit
                ? "可以导入版本，启停需管理员权限"
                : "只读访问，不能导入或启停版本"}
          </dd>
        </dl>
        <section className="skill-detail-section">
          <h3>文件内容</h3>
          <div className="skill-file-browser">
            <SkillFileTree files={skill.files} path={path} onSelect={setPath} />
            <div className="skill-file-viewer">
              <div className="skill-file-toolbar">
                <div>
                  <code>{path}</code>
                  <small>
                    {file?.size} B · {file?.encoding === "utf-8" ? "文本" : "二进制"}
                  </small>
                </div>
                <Button onClick={download} disabled={!bytes}>
                  下载文件
                </Button>
              </div>
              <QueryState label="Skill 文件" query={query}>
                {bytes && (
                  <pre className="skill-source">
                    {file?.encoding === "utf-8"
                      ? new TextDecoder().decode(bytes)
                      : "二进制资源，可下载查看。"}
                  </pre>
                )}
              </QueryState>
            </div>
          </div>
        </section>
        <section className="skill-detail-section">
          <h3>可授权脚本入口 · {skill.entrypoints.length}</h3>
          {skill.entrypoints.length ? (
            skill.entrypoints.map((entry) => <code key={entry}>{entry}</code>)
          ) : (
            <p>此版本用于提供指令与资料，不包含当前支持的脚本入口。</p>
          )}
          <p className="form-note">
            在 Agent 的「Skills」中勾选入口并发布后，Agent 可自主执行。脚本接收 JSON
            标准输入，文本结果进入当前运行记录；默认无网络和业务凭据。
          </p>
        </section>
        <small className="resource-id" title={skill.digest}>
          内容摘要 · {skill.digest}
        </small>
      </div>
    </Drawer>
  );
}

function ProjectSkills({ selectedId, onSelect }: ResourceSelection) {
  const query = useProjectPages("skills"),
    refresh = useProjectRefresh();
  const canEdit = useProjectAccess()?.permissions.includes("resource.edit") ?? false;
  const [importing, setImporting] = useState(false);
  const [updatePreview, setUpdatePreview] = useState<SkillImportPreview>();
  const projectId = useProjectId();
  const detailQuery = useQuery({
    queryKey: projectKey(projectId, "skills", selectedId ?? "", "detail"),
    queryFn: ({ signal }) =>
      unwrap(api.getSkill({ path: { projectId, id: selectedId ?? "" }, signal })),
    enabled: !!selectedId,
    gcTime: 0,
  });
  const selected = detailQuery.data;
  const skills = pageItems(query.data);
  return (
    <>
      <div className="skill-page-toolbar">
        <span>标准指令、参考资料和可授权脚本，按版本复用。</span>
        <Button
          type="primary"
          aria-label="导入 Skill"
          icon={<FileZipOutlined />}
          disabled={!canEdit}
          title={canEdit ? undefined : "导入需要资源编辑权限"}
          onClick={() => setImporting(true)}
        >
          导入 Skill
        </Button>
      </div>
      <QueryState label="Skills" query={query}>
        {skills.length ? (
          <>
            <div className="skill-grid">
              {skills.map((skill) => (
                <button
                  className="skill-card"
                  type="button"
                  key={skill.id}
                  onClick={() => onSelect(skill.id)}
                >
                  <div className="skill-card-head">
                    <FileZipOutlined />
                    <strong>{skill.name}</strong>
                    <Tag>v{skill.version}</Tag>
                    <Tag>项目自定义</Tag>
                  </div>
                  <p>{skill.description}</p>
                  <small className="skill-card-source">
                    {skill.source
                      ? skill.source.kind === "zip"
                        ? "ZIP 导入"
                        : `${skill.source.repository} · ${skill.source.commit.slice(0, 8)}`
                      : "历史导入"}
                  </small>
                  <div className="skill-card-meta">
                    <span>
                      {skill.files.length} 个文件 · {skill.entrypoints.length} 个脚本入口
                    </span>
                    <Tag color={skill.enabled ? "success" : "default"}>
                      {skill.enabled ? "可绑定" : "已停用"}
                    </Tag>
                  </div>
                </button>
              ))}
            </div>
            <PageMore query={query} count={skills.length} label="版本" />
          </>
        ) : (
          <section className="panel">
            <Blank
              title="将团队经验变成可复用的 Skills"
              description="从 skills.sh、GitHub、GitLab.com 或 ZIP 导入，检查内容后固定版本复用。脚本入口单独授权。"
              action={
                <Button disabled={!canEdit} onClick={() => setImporting(true)}>
                  导入第一个 Skill
                </Button>
              }
            />
          </section>
        )}
      </QueryState>
      {canEdit && importing && (
        <SkillImport
          onClose={() => setImporting(false)}
          onImported={(skill) => {
            setImporting(false);
            onSelect(skill.id);
            void refresh("skills");
          }}
        />
      )}
      {selectedId && !selected && (
        <Drawer open title="Skill 版本" onClose={() => onSelect()}>
          <QueryState label="Skill 版本" query={detailQuery}>
            {null}
          </QueryState>
        </Drawer>
      )}
      {canEdit && updatePreview && (
        <SkillImport
          initialPreview={updatePreview}
          onClose={() => setUpdatePreview(undefined)}
          onImported={(skill) => {
            setUpdatePreview(undefined);
            onSelect(skill.id);
            void refresh("skills");
          }}
        />
      )}
      {selected && !updatePreview && (
        <SkillDetails
          key={selected.id}
          skill={skills.find((s) => s.id === selected.id) ?? selected}
          onClose={() => onSelect()}
          onUpdate={setUpdatePreview}
        />
      )}
    </>
  );
}

export function SkillWorkspace(selection: ResourceSelection) {
  const [source, setSource] = useState("project");
  usePageActionTargets([
    {
      id: "skills.source",
      label: "能力目录来源",
      kind: "select",
      value: source,
      options: ["project", "system"],
      execute: (value) => {
        if (value !== "project" && value !== "system") throw new Error("目录来源无效");
        setSource(value);
      },
    },
  ]);
  return (
    <Tabs
      data-agent-target="skills.source"
      activeKey={source}
      onChange={setSource}
      destroyOnHidden
      items={[
        { key: "project", label: "项目自定义", children: <ProjectSkills {...selection} /> },
        { key: "system", label: "系统内置", children: <SystemCapabilityDirectory kind="skills" /> },
      ]}
    />
  );
}
