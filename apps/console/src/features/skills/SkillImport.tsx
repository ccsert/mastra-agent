import {
  BranchesOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  FileTextOutlined,
  FileZipOutlined,
  GithubOutlined,
  InboxOutlined,
  LinkOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import type { SkillDiscovery, SkillImportPreview, SkillVersion } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Drawer, Form, Input, Space, Table, Tabs, Tag, Upload } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { projectKey, useProjectId } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { useOperation } from "../../shared/useOperation";
import { SkillFileTree } from "./SkillFileTree";

type SkillSource = NonNullable<SkillVersion["source"]>;
const providerNames = { github: "GitHub", gitlab: "GitLab", "skills-sh": "skills.sh", zip: "ZIP" };
export function SkillProvenance({ source }: { source: SkillSource | null | undefined }) {
  if (!source) return <p className="form-note">历史版本未记录来源，可通过内容摘要识别固定内容。</p>;
  if (source.kind === "zip")
    return (
      <div className="skill-provenance">
        <FileZipOutlined />
        <strong>ZIP 导入</strong>
        <span>{source.fileName}</span>
      </div>
    );
  const repo = `https://${source.kind === "gitlab" ? "gitlab.com" : "github.com"}/${source.repository}`;
  const commitUrl = `${repo}/${source.kind === "gitlab" ? "-/commit" : "commit"}/${source.commit}`;
  return (
    <div className="skill-provenance">
      {source.kind === "github" ? <GithubOutlined /> : <LinkOutlined />}
      <strong>{providerNames[source.kind]}</strong>
      <a href={source.url} target="_blank" rel="noreferrer">
        {source.repository}
      </a>
      <span>
        <BranchesOutlined /> {source.ref === "HEAD" ? "默认分支" : source.ref}
      </span>
      <a href={commitUrl} target="_blank" rel="noreferrer" title={source.commit}>
        <code>{source.commit.slice(0, 12)}</code>
      </a>
      <code>{source.path || "仓库根目录"}</code>
    </div>
  );
}
function FilePreview({ preview, path }: { preview: SkillImportPreview; path: string }) {
  const projectId = useProjectId();
  const file = preview.manifest.files.find((f) => f.path === path);
  const oldFile = preview.baseVersion?.files.find((f) => f.path === path);
  const changed = preview.changes.some((f) => f.path === path);
  const query = useQuery({
    queryKey: projectKey(projectId, "skills", "preview", preview.id, path),
    queryFn: ({ signal }) =>
      unwrap(
        api.getSkillPreviewFile({ path: { projectId, id: preview.id }, query: { path }, signal }),
      ),
    enabled: !!file,
    gcTime: 0,
  });
  const previous = useQuery({
    queryKey: projectKey(projectId, "skills", preview.baseVersion?.id ?? "", "file", path),
    queryFn: ({ signal }) =>
      unwrap(
        api.getSkillFile({
          path: { projectId, id: preview.baseVersion?.id ?? "" },
          query: { path },
          signal,
        }),
      ),
    enabled: !!oldFile && changed,
    gcTime: 0,
  });
  const decode = (encoded: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  return (
    <div className={`skill-preview-code ${oldFile && changed ? "has-previous" : ""}`}>
      {oldFile && changed && (
        <section>
          <h4>当前 v{preview.baseVersion?.version}</h4>
          <QueryState label="原版本文件" query={previous}>
            {previous.data && (
              <pre className="skill-source">
                {oldFile.encoding === "utf-8"
                  ? decode(previous.data.contentBase64)
                  : "二进制资源，按内容摘要比较"}
              </pre>
            )}
          </QueryState>
        </section>
      )}
      <section>
        <h4>{file ? "待导入内容" : "新版已移除此文件"}</h4>
        {file && (
          <QueryState label="预览文件" query={query}>
            {query.data && (
              <pre className="skill-source">
                {file.encoding === "utf-8"
                  ? decode(query.data.contentBase64)
                  : `二进制资源 · ${file.size} B · SHA256 ${file.hash}`}
              </pre>
            )}
          </QueryState>
        )}
      </section>
    </div>
  );
}
const changeNames = { added: "新增", modified: "修改", removed: "移除" };
function Review({ preview }: { preview: SkillImportPreview }) {
  const [path, setPath] = useState("SKILL.md"),
    [tab, setTab] = useState("files");
  const manifest = preview.manifest;
  const files = [
    ...manifest.files,
    ...(preview.baseVersion?.files.filter((f) => !manifest.files.some((n) => n.path === f.path)) ??
      []),
  ];
  return (
    <>
      <div className="skill-review-title">
        <div>
          <h2>{manifest.name}</h2>
          <p>{manifest.description}</p>
        </div>
        <Tag color={preview.existingVersion ? "default" : "blue"}>
          {preview.existingVersion
            ? `已存在 v${preview.existingVersion.version}`
            : preview.baseVersion
              ? `新版本 v${preview.baseVersion.version + 1}`
              : "首次导入"}
        </Tag>
      </div>
      <SkillProvenance source={preview.source} />
      <div className="skill-review-facts">
        <span>
          <FileTextOutlined /> {manifest.files.length} 个文件
        </span>
        <span>
          <CodeOutlined /> {manifest.entrypoints.length} 个脚本入口
        </span>
        <span>
          <SafetyCertificateOutlined /> {manifest.license || "未声明许可证"}
        </span>
      </div>
      {preview.existingVersion && (
        <Alert
          className="form-alert"
          type="info"
          showIcon
          title={`内容与 v${preview.existingVersion.version} 完全一致，将复用现有版本${preview.existingVersion.enabled ? "" : "（已停用）"}`}
          description="已有版本的来源记录和启停状态保持不变。"
        />
      )}
      {preview.baseVersion && !preview.existingVersion && (
        <Alert
          className="form-alert"
          type="info"
          showIcon
          title={`与当前 v${preview.baseVersion.version} 比较：${preview.changes.length} 个文件发生变化`}
          description="导入后需要在 Agent 配置中选择新版本；已发布 Agent 继续使用原版本。"
        />
      )}
      {preview.baseVersion?.source &&
        JSON.stringify(
          preview.baseVersion.source.kind === "zip"
            ? "zip"
            : [preview.baseVersion.source.repository, preview.baseVersion.source.path],
        ) !==
          JSON.stringify(
            preview.source.kind === "zip"
              ? "zip"
              : [preview.source.repository, preview.source.path],
          ) && (
          <Alert
            className="form-alert"
            type="warning"
            showIcon
            title="项目中已有同名 Skill，但此次来源不同"
            description={
              <>
                <span>请检查版本差异。当前版本来源：</span>
                <SkillProvenance source={preview.baseVersion.source} />
              </>
            }
          />
        )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "files",
            label: "文件与指令",
            children: (
              <section className="skill-file-browser skill-import-browser">
                <SkillFileTree files={files} path={path} onSelect={setPath} />
                <div className="skill-file-viewer">
                  <div className="skill-file-toolbar">
                    <code>{path}</code>
                  </div>
                  <FilePreview key={`${preview.id}:${path}`} preview={preview} path={path} />
                </div>
              </section>
            ),
          },
          {
            key: "changes",
            label: `版本差异 · ${preview.changes.length}`,
            children: (
              <Table
                size="small"
                rowKey="path"
                dataSource={preview.changes}
                pagination={{ pageSize: 15, hideOnSinglePage: true }}
                locale={{ emptyText: "文件内容没有变化" }}
                columns={[
                  {
                    title: "变化",
                    dataIndex: "kind",
                    width: 90,
                    render: (kind: keyof typeof changeNames) => (
                      <Tag color={kind === "added" ? "green" : kind === "removed" ? "red" : "blue"}>
                        {changeNames[kind]}
                      </Tag>
                    ),
                  },
                  {
                    title: "文件",
                    dataIndex: "path",
                    render: (value: string) => (
                      <Button
                        type="link"
                        className="skill-path-link"
                        onClick={() => {
                          setPath(value);
                          setTab("files");
                        }}
                      >
                        {value}
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "compatibility",
            label: "兼容性与执行要求",
            children: (
              <div className="skill-compatibility">
                <Alert
                  type="success"
                  showIcon
                  title="标准指令和包内文件可读取"
                  description="已完成元数据、路径、文件类型、体积和内容摘要校验。"
                />
                {manifest.warnings.map((warning) => (
                  <Alert key={warning} type="warning" showIcon title={warning} />
                ))}
                <section>
                  <h3>运行环境</h3>
                  <p>
                    {manifest.compatibility ||
                      "包内未声明运行环境要求。平台未执行安装、依赖探测或脚本试跑。"}
                  </p>
                  <p>
                    脚本通过隔离 Runtime 运行，接收 JSON
                    标准输入，默认无网络和业务凭据；其他依赖需预先配置。
                  </p>
                </section>
                <section>
                  <h3>脚本入口 · {manifest.entrypoints.length}</h3>
                  {manifest.entrypoints.length ? (
                    manifest.entrypoints.map((entry) => <code key={entry}>{entry}</code>)
                  ) : (
                    <p>未发现当前支持的 .js / .mjs / .cjs / .py / .sh 脚本入口。</p>
                  )}
                </section>
                {manifest.allowedTools && (
                  <section>
                    <h3>包内工具声明</h3>
                    <code>{manifest.allowedTools}</code>
                  </section>
                )}
              </div>
            ),
          },
        ]}
      />
      <p className="form-note">
        <SafetyCertificateOutlined /> 导入用于保存固定内容。脚本入口需要在 Agent
        中由管理员单独授权，包内工具、网络或钩子声明不会自动生效。
      </p>
      <details className="skill-digest">
        <summary>完整内容摘要与预览有效期</summary>
        <code>{preview.digest}</code>
        <p>
          预览有效至 {new Date(preview.expiresAt).toLocaleString()}，确认时使用本次已保存的内容。
        </p>
      </details>
    </>
  );
}
async function encode(file: File) {
  if (file.size > 4 * 1024 * 1024) throw new Error("请选择不超过 4 MiB 的 ZIP 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function SkillImport({
  onClose,
  onImported,
  initialPreview,
}: {
  onClose(): void;
  onImported(skill: SkillVersion): void;
  initialPreview?: SkillImportPreview;
}) {
  const projectId = useProjectId(),
    { run, busy, error, setError } = useOperation();
  const [confirming, setConfirming] = useState(false);
  const [mode, setMode] = useState("remote"),
    [source, setSource] = useState({ url: "", ref: "", path: "" }),
    [discovery, setDiscovery] = useState<SkillDiscovery>(),
    [preview, setPreview] = useState(initialPreview),
    [file, setFile] = useState<File>();
  const sourceInput = () => ({
    url: source.url,
    ...(source.ref.trim() ? { ref: source.ref.trim() } : {}),
    ...(source.path.trim() ? { path: source.path.trim() } : {}),
  });
  const reset = () => {
    setDiscovery(undefined);
    setPreview(undefined);
    setError("");
  };
  const discover = () =>
    void run(async (signal) => {
      reset();
      setDiscovery(
        await unwrap(
          api.discoverSkills({ path: { projectId }, body: sourceInput(), signal }),
          signal,
        ),
      );
    });
  const remotePreview = (path: string) =>
    void run(async (signal) => {
      if (!discovery) return;
      setPreview(
        await unwrap(
          api.previewSkillImport({
            path: { projectId },
            body: { kind: "remote", source: sourceInput(), commit: discovery.source.commit, path },
            signal,
          }),
          signal,
        ),
      );
    });
  return (
    <Drawer
      title={initialPreview ? "检查上游更新" : "导入 Skill"}
      open
      onClose={onClose}
      size="min(1080px, 100vw)"
      closable={!confirming}
      keyboard={!confirming}
      mask={{ closable: !confirming }}
      footer={
        <div className="dialog-footer">
          <Button onClick={onClose} disabled={confirming}>
            取消
          </Button>
          {preview && !initialPreview && (
            <Button disabled={busy} onClick={() => setPreview(undefined)}>
              返回选择
            </Button>
          )}
          {preview ? (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              aria-label={preview.existingVersion ? "使用已有版本" : "确认导入固定版本"}
              loading={busy}
              onClick={() =>
                void run(async (signal) => {
                  setConfirming(true);
                  try {
                    const result = await unwrap(
                      api.confirmSkillImport({
                        path: { projectId, id: preview.id },
                        body: {},
                        signal,
                      }),
                      signal,
                    );
                    onImported(result.skill);
                  } finally {
                    if (!signal.aborted) setConfirming(false);
                  }
                })
              }
            >
              {preview.existingVersion ? "使用已有版本" : "确认导入固定版本"}
            </Button>
          ) : mode === "zip" ? (
            <Button
              type="primary"
              disabled={!file}
              loading={busy}
              onClick={() =>
                void run(async (signal) => {
                  if (!file) return;
                  const archiveBase64 = await encode(file);
                  signal.throwIfAborted();
                  setPreview(
                    await unwrap(
                      api.previewSkillImport({
                        path: { projectId },
                        body: { kind: "zip", archiveBase64, fileName: file.name },
                        signal,
                      }),
                      signal,
                    ),
                  );
                })
              }
            >
              校验并预览
            </Button>
          ) : (
            !discovery && (
              <Button
                type="primary"
                loading={busy}
                disabled={!source.url.trim()}
                onClick={discover}
              >
                解析来源
              </Button>
            )
          )}
        </div>
      }
    >
      <ol className="skill-import-steps" aria-label="导入步骤">
        {["选择来源", "选择 Skill", "检查并导入"].map((label, i) => (
          <li
            key={label}
            aria-current={(preview ? 2 : discovery ? 1 : 0) === i ? "step" : undefined}
          >
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && <Alert type="error" showIcon title={error} className="form-alert" />}
      {preview ? (
        <Review key={preview.id} preview={preview} />
      ) : (
        <>
          <Tabs
            activeKey={mode}
            onChange={(value) => {
              setMode(value);
              reset();
            }}
            items={[
              {
                key: "remote",
                disabled: busy,
                label: (
                  <Space>
                    <CloudDownloadOutlined />
                    来源链接
                  </Space>
                ),
                children: (
                  <>
                    <Form layout="vertical" disabled={busy} onFinish={discover}>
                      <Form.Item label="仓库或 Skill 详情链接">
                        <Input
                          value={source.url}
                          onChange={(e) => {
                            setSource({ ...source, url: e.target.value });
                            reset();
                          }}
                          aria-label="仓库或 Skill 详情链接"
                          placeholder="https://skills.sh/owner/repo/skill 或 owner/repo"
                          size="large"
                        />
                      </Form.Item>
                      <details className="skill-source-options">
                        <summary>指定分支与子目录（可选）</summary>
                        <div className="skill-source-fields">
                          <Form.Item label="分支、标签或完整提交号">
                            <Input
                              aria-label="分支、标签或完整提交号"
                              placeholder="默认分支"
                              value={source.ref}
                              onChange={(e) => {
                                setSource({ ...source, ref: e.target.value });
                                reset();
                              }}
                            />
                          </Form.Item>
                          <Form.Item label="仓库内目录">
                            <Input
                              aria-label="仓库内目录"
                              placeholder="例如 skills/frontend-design"
                              value={source.path}
                              onChange={(e) => {
                                setSource({ ...source, path: e.target.value });
                                reset();
                              }}
                            />
                          </Form.Item>
                        </div>
                      </details>
                    </Form>
                    {!discovery && (
                      <div className="skill-source-examples">
                        <h3>直接从已有生态导入</h3>
                        <p>
                          支持 skills.sh 详情、公开 GitHub / GitLab.com 仓库与 Skill
                          子目录。一个仓库中的多个 Skill 会分别列出。
                        </p>
                        <code>https://github.com/anthropics/skills</code>
                        <code>
                          https://skills.sh/vercel-labs/agent-skills/web-design-guidelines
                        </code>
                        <p>私有仓库、自建 Git 服务可先下载 Skill 后通过 ZIP 导入。</p>
                      </div>
                    )}
                    {discovery && (
                      <>
                        <SkillProvenance source={discovery.source} />
                        <h3>找到 {discovery.candidates.length} 个 Skill</h3>
                        <Table
                          size="small"
                          rowKey="path"
                          dataSource={discovery.candidates}
                          pagination={{ pageSize: 8, hideOnSinglePage: true }}
                          columns={[
                            {
                              title: "Skill / 所在目录",
                              key: "skill",
                              render: (_, candidate) => (
                                <div className="skill-candidate">
                                  <strong>{candidate.name}</strong>
                                  <code>{candidate.path || "仓库根目录"}</code>
                                </div>
                              ),
                            },
                            { title: "文件", dataIndex: "fileCount", width: 65 },
                            {
                              title: "",
                              key: "action",
                              width: 100,
                              render: (_, candidate) => (
                                <Button
                                  aria-label={`预览 ${candidate.name}`}
                                  disabled={busy}
                                  loading={busy && discovery.candidates.length === 1}
                                  onClick={() => remotePreview(candidate.path)}
                                >
                                  预览
                                </Button>
                              ),
                            },
                          ]}
                        />
                        {busy && <p role="status">正在读取固定提交中的文件并检查内容…</p>}
                      </>
                    )}
                  </>
                ),
              },
              {
                key: "zip",
                disabled: busy,
                label: (
                  <Space>
                    <FileZipOutlined />
                    本地 ZIP
                  </Space>
                ),
                children: (
                  <>
                    <Upload.Dragger
                      accept=".zip,application/zip"
                      multiple={false}
                      disabled={busy}
                      showUploadList={false}
                      beforeUpload={(file) => {
                        setFile(file);
                        setError("");
                        return false;
                      }}
                    >
                      <p className="ant-upload-drag-icon">
                        <InboxOutlined />
                      </p>
                      <p className="ant-upload-text">{file?.name ?? "选择或拖入一个 ZIP 包"}</p>
                      <p className="ant-upload-hint">
                        {file
                          ? `${(file.size / 1024).toFixed(1)} KiB · 点击重新选择`
                          : "一个包一个 Skill，最大 4 MiB"}
                      </p>
                    </Upload.Dragger>
                    <div className="skill-import-guide">
                      <h3>标准包结构</h3>
                      <pre>
                        {
                          "report-skill/\n├── SKILL.md       元数据与任务指令\n├── scripts/       可选脚本\n├── references/    参考资料\n└── assets/        模板与资源"
                        }
                      </pre>
                      <p>
                        也可将 SKILL.md 放在 ZIP 根目录。外层目录名需与 name
                        一致；确认前可查看全部文件、兼容性及版本差异。
                      </p>
                    </div>
                  </>
                ),
              },
            ]}
          />
          <p className="form-note">内容保存在当前项目，由平台托管。解析与预览不会执行包内脚本。</p>
        </>
      )}
    </Drawer>
  );
}
