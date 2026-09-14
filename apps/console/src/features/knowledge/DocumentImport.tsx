import {
  FileAddOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  InboxOutlined,
} from "@ant-design/icons";
import type { DocumentPreview, KnowledgeDocument } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Drawer, Table, Tabs, Tag, Upload } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { useLifetime } from "../../shared/useLifetime";
import { locationLabel, SourceSections } from "./DocumentReader";

export function DocumentImport({
  projectId,
  kbId,
  document,
  onClose,
  onImported,
}: {
  projectId: string;
  kbId: string;
  document?: KnowledgeDocument;
  onClose(): void;
  onImported(doc: KnowledgeDocument): void;
}) {
  const lifetime = useLifetime();
  const [preview, setPreview] = useState<DocumentPreview | null>(null),
    [error, setError] = useState(""),
    [parsing, setParsing] = useState(false),
    [saving, setSaving] = useState(false);
  async function parse(file: File) {
    const signal = lifetime();
    setParsing(true);
    setPreview(null);
    setError("");
    try {
      if (!/\.(pdf|docx|txt|md)$/i.test(file.name) || !file.size || file.size > 8 * 1024 * 1024)
        throw new Error("请选择 8 MiB 以内的 PDF、DOCX、TXT 或 Markdown 文件。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 32768)
        binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      signal.throwIfAborted();
      const result = await unwrap(
        api.previewKnowledgeDocument({
          path: { projectId, kbId },
          body: { filename: file.name, fileBase64: btoa(binary), documentId: document?.id },
          signal,
        }),
        signal,
      );
      setPreview(result);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      if (!signal.aborted) setParsing(false);
    }
    return Upload.LIST_IGNORE;
  }
  async function save() {
    if (!preview) return;
    const signal = lifetime();
    setSaving(true);
    setError("");
    try {
      const doc = await unwrap(
        api.importKnowledgeDocument({
          path: { projectId, kbId },
          body: { previewId: preview.id },
          signal,
        }),
        signal,
      );
      onImported(doc);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  }
  return (
    <Drawer
      open
      title={document ? `更新资料 · ${document.filename}` : "导入资料"}
      size="min(1000px, 100vw)"
      onClose={onClose}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      destroyOnHidden
      footer={
        <div className="document-import-footer">
          <span>{preview ? "已解析，确认后开始向量索引" : "选择文件并检查解析结果"}</span>
          <Button disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            icon={<FileAddOutlined />}
            disabled={!preview || parsing}
            loading={saving}
            onClick={() => void save()}
          >
            {preview?.unchanged ? "保留当前版本" : document ? "确认更新" : "确认入库"}
          </Button>
        </div>
      }
    >
      <p>先检查正文和分段，再确认入库。新版本处理完成后自动参与检索。</p>
      {document?.activeVersionId && (
        <Alert
          className="form-alert"
          type="info"
          showIcon
          title={`更新期间 v${document.activeVersion} 继续提供检索，新版失败不会中断已有资料。`}
        />
      )}
      {error && <Alert className="form-alert" type="error" showIcon title={error} />}
      <Upload.Dragger
        height={preview ? 112 : 180}
        accept=".pdf,.docx,.txt,.md"
        showUploadList={false}
        disabled={parsing || saving}
        beforeUpload={parse}
      >
        {!preview && (
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
        )}
        <p className="ant-upload-text">
          {parsing ? "正在解析文件…" : preview ? "重新选择文件" : "点击或拖放资料到这里"}
        </p>
        <p className="ant-upload-hint">
          <FilePdfOutlined /> 文本 PDF · <FileWordOutlined /> DOCX · TXT / Markdown · 8 MiB 以内
        </p>
      </Upload.Dragger>
      {preview && (
        <section className="document-import-review">
          <div className="document-reader-controls">
            <h3>{preview.filename}</h3>
            <Tag>{preview.format.toUpperCase()}</Tag>
            <span>
              {preview.sections.length} {preview.format === "pdf" ? "页" : "个段落"} ·{" "}
              {preview.chunks.length} 个分段
            </span>
          </div>
          {preview.unchanged && (
            <Alert type="info" title="文件内容与当前版本相同，将复用已有版本。" />
          )}
          {preview.warnings.map((w) => (
            <Alert key={w} className="form-alert" type="warning" title={w} />
          ))}
          <Tabs
            items={[
              {
                key: "source",
                label: "解析正文",
                children: <SourceSections key={preview.id} sections={preview.sections} />,
              },
              {
                key: "chunks",
                label: "分段预览",
                children: (
                  <Table
                    rowKey="ordinal"
                    dataSource={preview.chunks}
                    pagination={{ pageSize: 6, showSizeChanger: false }}
                    columns={[
                      { title: "位置", width: 110, render: (_, c) => locationLabel(c.location) },
                      {
                        title: "正文",
                        render: (_, c) => <p className="document-chunk-text">{c.content}</p>,
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </section>
      )}
    </Drawer>
  );
}
