import { FileTextOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import type { KnowledgeBase, KnowledgeDocument, Model } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Input, Progress, Select, Table, Tabs, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useProjectAccess } from "../../shared/access";
import { timestamp, unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import { useLifetime } from "../../shared/useLifetime";
import { DocumentImport } from "./DocumentImport";
import { DocumentReader, locationLabel } from "./DocumentReader";
import { knowledgeQueries } from "./queries";

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
export function KnowledgeDetails({ kb, models }: { kb: KnowledgeBase; models: Model[] }) {
  const canEdit = useProjectAccess()?.permissions.includes("resource.edit") ?? false;
  const projectId = kb.projectId,
    kbId = kb.id;
  const { message, modal } = App.useApp(),
    lifetime = useLifetime(),
    refresh = useProjectRefresh(),
    client = useQueryClient();
  const confirmation = useRef<ReturnType<typeof modal.confirm> | null>(null);
  useEffect(() => () => confirmation.current?.destroy(), []);
  const documentsQuery = useInfiniteQuery(knowledgeQueries.documents(projectId, kbId)),
    documents = pageItems(documentsQuery.data);
  const [error, setError] = useState(""),
    [importing, setImporting] = useState<{ document?: KnowledgeDocument } | null>(null),
    [query, setQuery] = useState(""),
    [topK, setTopK] = useState(5),
    [searchId, setSearchId] = useState(""),
    [submitting, setSubmitting] = useState(false),
    [preview, setPreview] = useState<{
      id: string;
      versionId?: string;
      location?: api.SourceLocation | null;
      excerpt?: string;
    } | null>(null);
  const searchQuery = useQuery(knowledgeQueries.search(projectId, kbId, searchId)),
    search = searchQuery.data;
  const searching = submitting || (!!search && ["queued", "running"].includes(search.status));
  async function retry(doc: KnowledgeDocument) {
    const signal = lifetime();
    try {
      await unwrap(
        api.retryKnowledgeDocument({ path: { projectId, kbId, id: doc.id }, body: {}, signal }),
        signal,
      );
      void refresh("knowledgeBases");
    } catch (error) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : "重试失败");
    }
  }
  function remove(doc: KnowledgeDocument) {
    const signal = lifetime();
    confirmation.current?.destroy();
    confirmation.current = modal.confirm({
      title: `删除「${doc.filename}」？`,
      content:
        "删除原文与检索分段，并终止未完成的处理任务。已有会话中的引用和回答仍按会话保留规则保存。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        signal.throwIfAborted();
        await unwrap(
          api.deleteKnowledgeDocument({ path: { projectId, kbId, id: doc.id }, body: {}, signal }),
          signal,
        );
        // Removed documents must not reopen from the cached plaintext preview.
        client.removeQueries({
          queryKey: knowledgeQueries.chunks(projectId, kbId, doc.id).queryKey,
        });
        setPreview(null);
        await refresh("knowledgeBases");
      },
    });
  }
  async function runSearch() {
    const signal = lifetime();
    setSubmitting(true);
    setError("");
    setSearchId("");
    try {
      const result = await unwrap(
        api.searchKnowledge({ path: { projectId, kbId }, body: { query, topK }, signal }),
        signal,
      );
      client.setQueryData(knowledgeQueries.search(projectId, kbId, result.id).queryKey, result);
      setSearchId(result.id);
    } catch (error) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : "检索失败");
    } finally {
      if (!signal.aborted) setSubmitting(false);
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
      <div className="knowledge-heading">
        <div>
          <span className="eyebrow">团队资料</span>
          <h2>{kb.name}</h2>
          <p>{kb.description || "上传文档，让 Agent 从团队资料中找到答案。"}</p>
        </div>
        <Button
          icon={<ReloadOutlined />}
          aria-label="刷新知识库"
          onClick={() => void refresh("knowledgeBases").catch((e) => setError(e.message))}
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
            label: `文档 · ${kb.documentCount}`,
            children: (
              <>
                <div className="knowledge-document-toolbar">
                  <p>PDF、DOCX、TXT 和 Markdown；可预览正文、追溯版本与引用。</p>
                  {canEdit && (
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setImporting({})}>
                      导入资料
                    </Button>
                  )}
                </div>
                <QueryState label="文档" query={documentsQuery}>
                  <Table<KnowledgeDocument>
                    className="knowledge-documents"
                    rowKey="id"
                    dataSource={documents}
                    pagination={false}
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
                              <small>
                                v{d.version ?? 1} · {timestamp(d.createdAt)}
                              </small>
                            </div>
                          </div>
                        ),
                      },
                      {
                        title: "状态",
                        render: (_, d) => (
                          <div>
                            <Tag color={status[d.status][1]}>{status[d.status][0]}</Tag>
                            {d.activeVersionId && d.activeVersionId !== d.versionId && (
                              <small>v{d.activeVersion} 继续提供检索</small>
                            )}
                            {d.status === "processing" && !!d.totalChunks && (
                              <Progress
                                size="small"
                                percent={Math.round(((d.indexedCount ?? 0) / d.totalChunks) * 100)}
                                format={() => `${d.indexedCount ?? 0}/${d.totalChunks}`}
                              />
                            )}
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
                        width: 225,
                        render: (_, d) => (
                          <>
                            <Button
                              size="small"
                              type="text"
                              onClick={() => setPreview({ id: d.id })}
                            >
                              阅读资料
                            </Button>
                            {canEdit && d.status === "failed" && (
                              <Button size="small" type="text" onClick={() => void retry(d)}>
                                重试
                              </Button>
                            )}
                            {canEdit && (
                              <>
                                <Button
                                  size="small"
                                  type="text"
                                  disabled={["queued", "processing"].includes(d.status)}
                                  onClick={() => setImporting({ document: d })}
                                >
                                  更新
                                </Button>
                                <Button size="small" type="text" danger onClick={() => remove(d)}>
                                  删除
                                </Button>
                              </>
                            )}
                          </>
                        ),
                      },
                    ]}
                  />
                  <PageMore query={documentsQuery} count={documents.length} label="文档" />
                </QueryState>
              </>
            ),
          },
          {
            key: "search",
            label: "检索测试",
            children: (
              <div className="retrieval-test">
                <p>输入业务问题，查看向量召回和重排后的资料片段，再将知识库绑定到 Agent。</p>
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
                      disabled={!canEdit || !query.trim() || !kb.readyCount}
                      onClick={() => void runSearch()}
                    >
                      测试检索
                    </Button>
                  </div>
                </div>
                {!kb.readyCount && (
                  <Alert type="info" title="请先上传文档，等待处理完成后再测试。" />
                )}
                {searchId && (
                  <QueryState label="检索结果" query={searchQuery}>
                    {null}
                  </QueryState>
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
                    {search.status === "succeeded" && <span>{search.results.length} 个片段</span>}
                  </div>
                )}
                {search?.status === "failed" && (
                  <Alert
                    type="error"
                    title={failure[search.errorCode ?? ""] ?? "检索未完成，请检查模型服务。"}
                  />
                )}
                {search?.results.map((hit, index) => (
                  <article className="knowledge-source" key={hit.id}>
                    <header>
                      <strong>
                        {index + 1}. {hit.filename}
                      </strong>
                      <span>
                        v{hit.version ?? 1} · {locationLabel(hit.location)}
                      </span>
                    </header>
                    <p>{hit.content}</p>
                    <footer>
                      <Button
                        size="small"
                        type="link"
                        onClick={() =>
                          setPreview({
                            id: hit.documentId,
                            versionId: hit.versionId,
                            location: hit.location,
                            excerpt: hit.content,
                          })
                        }
                      >
                        定位原文
                      </Button>
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
      {preview && (
        <DocumentReader
          key={`${preview.id}-${preview.versionId ?? "latest"}`}
          projectId={projectId}
          kbId={kbId}
          documentId={preview.id}
          versionId={preview.versionId}
          location={preview.location}
          excerpt={preview.excerpt}
          onClose={() => setPreview(null)}
        />
      )}
      {importing && (
        <DocumentImport
          projectId={projectId}
          kbId={kbId}
          document={importing.document}
          onClose={() => setImporting(null)}
          onImported={() => {
            setImporting(null);
            void refresh("knowledgeBases");
            void message.success("资料已提交，处理完成后可检索");
          }}
        />
      )}
    </>
  );
}
