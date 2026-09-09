import { FileZipOutlined, InboxOutlined } from "@ant-design/icons";
import type { SkillVersion } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Select, Space, Tag, Upload } from "antd";
import { useState } from "react";
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
import { useOperation } from "../../shared/useOperation";

async function encode(file: File) {
  if (file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MiB 的 ZIP 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function ImportSkill({
  onClose,
  onImported,
}: {
  onClose(): void;
  onImported(skill: SkillVersion): void;
}) {
  const projectId = useProjectId(),
    { run, busy, error } = useOperation();
  const [file, setFile] = useState<File>();
  return (
    <Drawer
      title="导入标准 Skill 包"
      open
      onClose={onClose}
      size={600}
      footer={
        <div className="dialog-footer">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!file}
            onClick={() =>
              void run(async (signal) => {
                if (!file) return;
                const archiveBase64 = await encode(file);
                signal.throwIfAborted();
                const skill = await unwrap(
                  api.uploadSkill({ path: { projectId }, body: { archiveBase64 }, signal }),
                  signal,
                );
                onImported(skill);
              })
            }
          >
            校验并导入
          </Button>
        </div>
      }
    >
      <p className="form-note">
        导入后可查看包内指令和脚本，在 Agent
        中选择固定版本并授权脚本入口。同名内容更新会形成新版本，重复上传同一内容不会重复创建。
      </p>
      {error && <Alert type="error" title={error} showIcon className="form-alert" />}
      <Upload.Dragger
        accept=".zip,application/zip"
        multiple={false}
        disabled={busy}
        showUploadList={false}
        beforeUpload={(file) => {
          setFile(file);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{file?.name ?? "选择或拖入一个 ZIP 包"}</p>
        <p className="ant-upload-hint">
          {file
            ? `${(file.size / 1024).toFixed(1)} KiB · 点击可重新选择`
            : "一个包一个 Skill，最大 4 MiB"}
        </p>
      </Upload.Dragger>
      <div className="skill-import-guide">
        <h3>包内结构</h3>
        <pre>
          {
            "report-skill/\n├── SKILL.md          必需：标准元数据和指令\n├── scripts/          可选：脚本\n├── references/       可选：参考资料\n└── assets/           可选：模板及资源"
          }
        </pre>
        <p>
          也可将 SKILL.md 直接放在 ZIP 根目录。外层目录名须与 name
          一致。平台检查路径、链接、文件数量和展开体积；包内 allowed-tools 不会自动授予权限。
        </p>
      </div>
      <Alert
        type="info"
        title="当前导入位置：平台托管"
        description="包内容保存在平台，供已连接的托管 Runtime 使用。请在这里导入允许由平台保存的内容。"
      />
    </Drawer>
  );
}
function SkillDetails({ skill, onClose }: { skill: SkillVersion; onClose(): void }) {
  const projectId = useProjectId(),
    refresh = useProjectRefresh(),
    { message } = App.useApp();
  const { run, busy, error } = useOperation();
  const [path, setPath] = useState("SKILL.md");
  const query = useQuery({
    queryKey: projectKey(projectId, "skills", skill.id, "file", path),
    queryFn: ({ signal }) =>
      unwrap(api.getSkillFile({ path: { projectId, id: skill.id }, query: { path }, signal })),
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
        <Space>
          <FileZipOutlined />
          {skill.name}
          <Tag>v{skill.version}</Tag>
        </Space>
      }
      open
      onClose={onClose}
      size={900}
    >
      <div className="skill-detail-heading">
        <div>
          <Tag color={skill.enabled ? "success" : "default"}>
            {skill.enabled ? "可绑定" : "已停用"}
          </Tag>
          <span className="muted">{timestamp(skill.createdAt)}</span>
        </div>
        <Button
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
      </div>
      {error && <Alert type="error" title={error} />}
      <p>{skill.description}</p>
      {skill.compatibility && <p className="form-note">环境要求：{skill.compatibility}</p>}
      {skill.warnings.map((warning) => (
        <Alert key={warning} type="warning" title={warning} className="form-alert" />
      ))}
      <div className="skill-file-toolbar">
        <Select
          aria-label="Skill 文件"
          value={path}
          onChange={setPath}
          options={skill.files.map((f) => ({ value: f.path, label: `${f.path} · ${f.size} B` }))}
          style={{ flex: 1 }}
        />
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
      <div className="skill-entrypoints">
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
      </div>
      <small className="resource-id">内容摘要 · {skill.digest}</small>
    </Drawer>
  );
}
export function SkillWorkspace() {
  const query = useProjectPages("skills"),
    refresh = useProjectRefresh();
  const [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<SkillVersion>();
  const skills = pageItems(query.data);
  return (
    <>
      <div className="skill-page-toolbar">
        <span>标准指令、参考资料和可授权脚本，按版本复用。</span>
        <Button type="primary" icon={<FileZipOutlined />} onClick={() => setImporting(true)}>
          导入 Skill 包
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
                  onClick={() => setSelected(skill)}
                >
                  <div className="skill-card-head">
                    <FileZipOutlined />
                    <strong>{skill.name}</strong>
                    <Tag>v{skill.version}</Tag>
                  </div>
                  <p>{skill.description}</p>
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
              description="导入符合 Agent Skills 标准的 ZIP 包，让 Agent 按需读取指令和参考资料。脚本入口单独授权。"
              action={<Button onClick={() => setImporting(true)}>导入第一个 Skill</Button>}
            />
          </section>
        )}
      </QueryState>
      {importing && (
        <ImportSkill
          onClose={() => setImporting(false)}
          onImported={(skill) => {
            setImporting(false);
            setSelected(skill);
            void refresh("skills");
          }}
        />
      )}
      {selected && (
        <SkillDetails
          key={selected.id}
          skill={skills.find((s) => s.id === selected.id) ?? selected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
