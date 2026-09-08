import {
  BookOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type {
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSearch,
  Model,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
  Upload,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { timestamp, unwrap } from "./api";

const status: Record<KnowledgeDocument["status"], [string, string]> = {
  queued: ["排队中", "default"],
  processing: ["处理中", "processing"],
  ready: ["可检索", "success"],
  failed: ["处理失败", "error"],
  deleted: ["已删除", "default"],
};
const failure: Record<string, string> = {
  MODEL_ERROR: "模型调用失败，请检查服务和凭据。",
  DIMENSION_MISMATCH: "模型返回的向量维度与知识库不一致。",
  INVALID_MODEL_RESPONSE: "模型响应格式不符合约定。",
  DOCUMENT_TOO_LARGE: "文档分段超过 256 段，请拆分后上传。",
  RUNTIME_LOST: "Runtime 执行中断，可重试。",
  RUNTIME_UNAVAILABLE: "Runtime 未能及时领取任务。",
  TIMEOUT: "处理超时，可重试。",
  RUNTIME_ERROR: "处理未完成，请检查 Runtime 和模型配置。",
};
export function KnowledgeWorkspace({
  projectId,
  models,
  onChanged,
  onConfigureModels,
}: {
  projectId: string;
  models: Model[];
  onChanged: () => void;
  onConfigureModels: () => void;
}) {
  const { modal, message } = App.useApp();
  const [bases, setBases] = useState<KnowledgeBase[]>([]),
    [selected, setSelected] = useState(""),
    [documents, setDocuments] = useState<KnowledgeDocument[]>([]),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState(0),
    [query, setQuery] = useState(""),
    [topK, setTopK] = useState(5),
    [search, setSearch] = useState<KnowledgeSearch | null>(null),
    [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<KnowledgeDocument | null>(null),
    [chunks, setChunks] = useState<KnowledgeChunk[]>([]),
    [previewBusy, setPreviewBusy] = useState(false),
    [previewError, setPreviewError] = useState("");
  const [form] = Form.useForm();
  const selectionRef = useRef(selected),
    searchEpoch = useRef(0),
    previewEpoch = useRef(0),
    mounted = useRef(true);
  selectionRef.current = selected;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchEpoch.current++;
      previewEpoch.current++;
    };
  }, []);
  const refreshBases = useCallback(async () => {
    const items = await unwrap(api.listKnowledgeBases({ path: { projectId } }));
    if (!mounted.current) return;
    setBases(items);
    setSelected((current) =>
      items.some((k) => k.id === current) ? current : (items[0]?.id ?? ""),
    );
  }, [projectId]);
  const refreshDocuments = useCallback(async () => {
    if (!selected) return;
    const items = await unwrap(api.listKnowledgeDocuments({ path: { projectId, kbId: selected } }));
    if (mounted.current && selectionRef.current === selected) setDocuments(items);
  }, [projectId, selected]);
  useEffect(() => {
    void refreshBases().catch((e) => setError(e.message));
  }, [refreshBases]);
  useEffect(() => {
    setDocuments([]);
    setSearch(null);
    setSearching(false);
    setPreview(null);
    setError("");
    searchEpoch.current++;
    previewEpoch.current++;
    void refreshDocuments().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void Promise.all([refreshBases(), refreshDocuments()]).catch((e) => {
        if (mounted.current) setError(e.message);
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [refreshBases, refreshDocuments]);
  const kb = bases.find((k) => k.id === selected),
    embeddings = models.filter((m) => m.kind === "embedding"),
    rerankers = models.filter((m) => m.kind === "rerank");
  async function create(values: {
    name: string;
    description?: string;
    embeddingModelId: string;
    rerankModelId?: string;
    chunkSize: number;
    chunkOverlap: number;
  }) {
    setSaving(true);
    setError("");
    try {
      const item = await unwrap(
        api.createKnowledgeBase({
          path: { projectId },
          body: { ...values, rerankModelId: values.rerankModelId ?? null },
        }),
      );
      await refreshBases();
      setSelected(item.id);
      setCreating(false);
      form.resetFields();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }
  async function upload(file: File) {
    const kbId = selected;
    setUploading((n) => n + 1);
    setError("");
    try {
      if (!/\.(txt|md)$/i.test(file.name) || file.size > 800000)
        throw new Error("请选择不超过 800 KB 的 UTF-8 TXT 或 Markdown 文件。");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error("文档不是有效 UTF-8 文本，请转换编码后上传。");
      }
      if (content.length > 200000) throw new Error("单份文档最多 20 万字符，请拆分后上传。");
      await unwrap(
        api.uploadKnowledgeDocument({
          path: { projectId, kbId },
          body: { filename: file.name, content },
        }),
      );
      if (selectionRef.current === kbId) {
        await refreshDocuments();
        await refreshBases();
      }
      void message.success(`${file.name} 已提交处理`);
    } catch (e) {
      if (selectionRef.current === kbId) setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      if (mounted.current) setUploading((n) => n - 1);
    }
    return Upload.LIST_IGNORE;
  }
  async function inspect(doc: KnowledgeDocument) {
    const epoch = ++previewEpoch.current;
    setPreview(doc);
    setPreviewBusy(true);
    setPreviewError("");
    setChunks([]);
    try {
      const result = await unwrap(
        api.listKnowledgeChunks({ path: { projectId, kbId: selected, id: doc.id } }),
      );
      if (epoch === previewEpoch.current) setChunks(result);
    } catch (e) {
      if (epoch === previewEpoch.current)
        setPreviewError(e instanceof Error ? e.message : "分段加载失败");
    } finally {
      if (epoch === previewEpoch.current) setPreviewBusy(false);
    }
  }
  async function retry(doc: KnowledgeDocument) {
    try {
      await unwrap(
        api.retryKnowledgeDocument({ path: { projectId, kbId: selected, id: doc.id }, body: {} }),
      );
      await refreshDocuments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重试失败");
    }
  }
  function remove(doc: KnowledgeDocument) {
    modal.confirm({
      title: `删除「${doc.filename}」？`,
      content:
        "删除原文与检索分段，并终止未完成的处理任务。已有会话中的引用和回答仍按会话保留规则保存。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await unwrap(
          api.deleteKnowledgeDocument({
            path: { projectId, kbId: selected, id: doc.id },
            body: {},
          }),
        );
        await refreshDocuments();
        await refreshBases();
      },
    });
  }
  async function runSearch() {
    const epoch = ++searchEpoch.current,
      kbId = selected;
    setSearching(true);
    setError("");
    setSearch(null);
    try {
      let result = await unwrap(
        api.searchKnowledge({ path: { projectId, kbId }, body: { query, topK } }),
      );
      while (epoch === searchEpoch.current && mounted.current) {
        setSearch(result);
        if (!["queued", "running"].includes(result.status)) break;
        await new Promise((r) => setTimeout(r, 700));
        if (epoch !== searchEpoch.current) break;
        result = await unwrap(api.getKnowledgeSearch({ path: { projectId, kbId, id: result.id } }));
      }
    } catch (e) {
      if (epoch === searchEpoch.current) setError(e instanceof Error ? e.message : "检索失败");
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  }
  return (
    <>
      {error && (
        <Alert
          type="error"
          title={error}
          className="form-alert"
          closable={{ onClose: () => setError("") }}
        />
      )}
      <div className="knowledge-workspace">
        <aside className="knowledge-list panel">
          <div className="knowledge-list-header">
            <strong>
              项目知识库 <span>{bases.length}</span>
            </strong>
            <Button
              type="text"
              aria-label="创建知识库"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            />
          </div>
          {bases.map((k) => (
            <button
              type="button"
              key={k.id}
              className={`knowledge-item ${selected === k.id ? "selected" : ""}`}
              onClick={() => setSelected(k.id)}
            >
              <BookOutlined />
              <span>
                <strong>{k.name}</strong>
                <small>
                  {k.readyCount} 份可检索 · {k.chunkCount} 个分段
                </small>
              </span>
            </button>
          ))}
          {!bases.length && (
            <div className="knowledge-list-empty">
              <p>为团队建立第一份可检索的资料库。</p>
              <Button type="primary" onClick={() => setCreating(true)}>
                创建知识库
              </Button>
            </div>
          )}
        </aside>
        <section className="knowledge-detail panel">
          {kb ? (
            <>
              <div className="knowledge-heading">
                <div>
                  <span className="eyebrow">团队资料</span>
                  <h2>{kb.name}</h2>
                  <p>{kb.description || "上传文档，让 Agent 从团队资料中找到答案。"}</p>
                </div>
                <Button
                  icon={<ReloadOutlined />}
                  aria-label="刷新知识库"
                  onClick={() =>
                    void Promise.all([refreshBases(), refreshDocuments()]).catch((e) =>
                      setError(e.message),
                    )
                  }
                />
              </div>
              <div className="knowledge-meta">
                <Tag>平台托管</Tag>
                <span>{models.find((m) => m.id === kb.embeddingModelId)?.name ?? "向量模型"}</span>
                <span>{kb.dimensions ? `${kb.dimensions} 维` : "首份文档确定维度"}</span>
                <span>
                  {kb.chunkSize} 字符 / 重叠 {kb.chunkOverlap}
                </span>
                {kb.rerankModelId && <Tag color="blue">已配置重排</Tag>}
              </div>
              <Tabs
                items={[
                  {
                    key: "documents",
                    label: `文档 · ${documents.length}`,
                    children: (
                      <>
                        <Upload.Dragger
                          accept=".txt,.md"
                          multiple
                          showUploadList={false}
                          beforeUpload={(file) => upload(file)}
                          disabled={uploading > 0}
                        >
                          <p className="ant-upload-drag-icon">
                            <InboxOutlined />
                          </p>
                          <p className="ant-upload-text">
                            {uploading ? `正在提交 ${uploading} 份文档…` : "点击或拖放文件到这里"}
                          </p>
                          <p className="ant-upload-hint">
                            UTF-8 TXT / Markdown · 单份 800 KB、20 万字符以内 ·
                            完成处理后自动参与检索
                          </p>
                        </Upload.Dragger>
                        <Table<KnowledgeDocument>
                          className="knowledge-documents"
                          rowKey="id"
                          dataSource={documents}
                          pagination={{ pageSize: 10, hideOnSinglePage: true }}
                          scroll={{ x: 600 }}
                          locale={{
                            emptyText: (
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description="上传产品说明、业务规则或操作手册"
                              />
                            ),
                          }}
                          columns={[
                            {
                              title: "文档",
                              dataIndex: "filename",
                              render: (_, d) => (
                                <div className="document-name">
                                  <FileTextOutlined />
                                  <div>
                                    <strong>{d.filename}</strong>
                                    <small>{timestamp(d.createdAt)}</small>
                                  </div>
                                </div>
                              ),
                            },
                            {
                              title: "状态",
                              render: (_, d) => (
                                <div>
                                  <Tag color={status[d.status][1]}>{status[d.status][0]}</Tag>
                                  {d.errorCode && (
                                    <small className="document-error">
                                      {failure[d.errorCode] ?? d.errorCode}
                                    </small>
                                  )}
                                </div>
                              ),
                            },
                            { title: "分段", dataIndex: "chunkCount", width: 65 },
                            {
                              title: "操作",
                              width: 150,
                              render: (_, d) => (
                                <>
                                  <Button
                                    size="small"
                                    type="text"
                                    disabled={d.status !== "ready"}
                                    onClick={() => void inspect(d)}
                                  >
                                    查看分段
                                  </Button>
                                  {d.status === "failed" && (
                                    <Button size="small" type="text" onClick={() => void retry(d)}>
                                      重试
                                    </Button>
                                  )}
                                  <Button size="small" type="text" danger onClick={() => remove(d)}>
                                    删除
                                  </Button>
                                </>
                              ),
                            },
                          ]}
                        />
                      </>
                    ),
                  },
                  {
                    key: "search",
                    label: "检索测试",
                    children: (
                      <div className="retrieval-test">
                        <p>
                          输入业务问题，查看向量召回和重排后的资料片段，再将知识库绑定到 Agent。
                        </p>
                        <div className="retrieval-controls">
                          <Input.TextArea
                            aria-label="检索问题"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            rows={3}
                            maxLength={2000}
                            placeholder="例如：A5000 有多少显存？"
                          />
                          <div>
                            <Select
                              aria-label="返回片段数"
                              value={topK}
                              onChange={setTopK}
                              options={[3, 5, 10].map((n) => ({ value: n, label: `返回 ${n} 段` }))}
                            />
                            <Button
                              type="primary"
                              icon={<SearchOutlined />}
                              loading={searching}
                              disabled={!query.trim() || !kb.readyCount}
                              onClick={() => void runSearch()}
                            >
                              测试检索
                            </Button>
                          </div>
                        </div>
                        {!kb.readyCount && (
                          <Alert type="info" title="请先上传文档，等待处理完成后再测试。" />
                        )}
                        {search && (
                          <div className="retrieval-status">
                            <Tag
                              color={
                                search.status === "succeeded"
                                  ? "success"
                                  : search.status === "failed"
                                    ? "error"
                                    : "processing"
                              }
                            >
                              {
                                {
                                  queued: "排队中",
                                  running: "检索中",
                                  succeeded: "检索完成",
                                  failed: "检索失败",
                                  cancelled: "已取消",
                                }[search.status]
                              }
                            </Tag>
                            {search.status === "succeeded" && (
                              <span>{search.results.length} 个片段</span>
                            )}
                          </div>
                        )}
                        {search?.status === "failed" && (
                          <Alert
                            type="error"
                            title={
                              failure[search.errorCode ?? ""] ?? "检索未完成，请检查模型服务。"
                            }
                          />
                        )}
                        {search?.results.map((hit, index) => (
                          <article className="knowledge-source" key={hit.id}>
                            <header>
                              <strong>
                                {index + 1}. {hit.filename}
                              </strong>
                              <span>片段 {hit.ordinal + 1}</span>
                            </header>
                            <p>{hit.content}</p>
                            <footer>
                              <span>向量相似度 {hit.similarity.toFixed(4)}</span>
                              {hit.rerankScore !== null && (
                                <span>重排分数 {hit.rerankScore.toFixed(4)}</span>
                              )}
                            </footer>
                          </article>
                        ))}
                        {search?.status === "succeeded" && !search.results.length && (
                          <Empty description="没有可用的资料片段" />
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <div className="knowledge-welcome">
              <BookOutlined />
              <h2>让 Agent 使用团队的知识</h2>
              <p>接入向量模型，建立知识库，上传资料。通过检索测试查看来源，再绑定到 Agent。</p>
              <Button onClick={() => setCreating(true)} type="primary">
                新建知识库
              </Button>
            </div>
          )}
        </section>
      </div>
      <Drawer
        title="创建知识库"
        open={creating}
        onClose={() => setCreating(false)}
        size={520}
        destroyOnHidden
        footer={
          <div className="dialog-footer">
            <Button onClick={() => setCreating(false)}>取消</Button>
            <Button
              type="primary"
              disabled={!embeddings.length}
              loading={saving}
              onClick={() => form.submit()}
            >
              创建
            </Button>
          </div>
        }
      >
        {error && <Alert type="error" title={error} className="form-alert" />}
        {!embeddings.length ? (
          <Empty description="先接入一个向量模型服务">
            <Button
              onClick={() => {
                setCreating(false);
                onConfigureModels();
              }}
            >
              接入向量模型
            </Button>
          </Empty>
        ) : (
          <Form
            form={form}
            layout="vertical"
            onFinish={create}
            initialValues={{ chunkSize: 800, chunkOverlap: 80 }}
          >
            <Form.Item
              name="name"
              label="知识库名称"
              rules={[{ required: true, whitespace: true, message: "请输入名称" }]}
            >
              <Input maxLength={80} placeholder="例如：产品与业务资料" />
            </Form.Item>
            <Form.Item name="description" label="说明">
              <Input.TextArea maxLength={500} rows={2} />
            </Form.Item>
            <Form.Item
              name="embeddingModelId"
              label="向量模型"
              rules={[{ required: true, message: "请选择向量模型" }]}
            >
              <Select
                options={embeddings.map((m) => ({
                  value: m.id,
                  label: `${m.name}${m.dimensions ? ` · ${m.dimensions} 维` : ""}`,
                }))}
              />
            </Form.Item>
            <Form.Item name="rerankModelId" label="重排模型（可选）">
              <Select
                allowClear
                placeholder="使用向量相似度排序"
                options={rerankers.map((m) => ({ value: m.id, label: m.name }))}
              />
            </Form.Item>
            <div className="knowledge-form-row">
              <Form.Item name="chunkSize" label="分段字符数" rules={[{ required: true }]}>
                <InputNumber min={200} max={2000} precision={0} />
              </Form.Item>
              <Form.Item name="chunkOverlap" label="重叠字符数" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} precision={0} />
              </Form.Item>
            </div>
            <Alert
              type="info"
              title="知识库固定模型与分段配置。需要更换模型或维度时，请创建新知识库并重新入库。"
            />
          </Form>
        )}
      </Drawer>
      <Drawer
        title={preview?.filename ?? "文档分段"}
        open={!!preview}
        onClose={() => {
          previewEpoch.current++;
          setPreview(null);
        }}
        size={640}
        destroyOnHidden
      >
        {previewError && <Alert title={previewError} type="error" />}
        {previewBusy ? (
          <Spin />
        ) : (
          chunks.map((c) => (
            <article className="knowledge-source" key={c.id}>
              <header>
                <strong>片段 {c.ordinal + 1}</strong>
                <span>{c.content.length} 字符</span>
              </header>
              <p>{c.content}</p>
              <footer>文档摘要 {c.contentHash.slice(0, 12)}</footer>
            </article>
          ))
        )}
      </Drawer>
    </>
  );
}
