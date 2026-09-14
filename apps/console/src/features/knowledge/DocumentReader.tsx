import { FileSearchOutlined, HistoryOutlined } from "@ant-design/icons";
import type { DocumentSource, SourceLocation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Drawer, Select, Table, Tabs, Tag } from "antd";
import { useState } from "react";
import { timestamp, unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";

export function locationLabel(location?: SourceLocation | null) {
  if (!location) return "历史资料未记录位置";
  const range =
    location.endIndex && location.endIndex !== location.index
      ? `${location.index}–${location.endIndex}`
      : location.index;
  return location.kind === "page" ? `第 ${range} 页` : `段落 ${range}`;
}
export function SourceSections({
  sections,
  initialIndex = 1,
  initialEndIndex,
  excerpt,
}: {
  sections: DocumentSource["sections"];
  initialIndex?: number;
  initialEndIndex?: number;
  excerpt?: string;
}) {
  const [index, setIndex] = useState(initialIndex),
    [endIndex, setEndIndex] = useState(initialEndIndex ?? initialIndex);
  const section = sections.find((s) => s.location.index === index) ?? sections[0];
  const visible = sections.filter(
    (s) => s.location.index >= (section?.location.index ?? 1) && s.location.index <= endIndex,
  );
  const content = (visible.length ? visible : section ? [section] : [])
    .map((s) => s.content)
    .join("\n\n");
  const at = excerpt ? content.indexOf(excerpt) : -1;
  return (
    <div className="document-reader-source">
      <div className="document-reader-controls">
        <Select
          aria-label="原文位置"
          value={section?.location.index}
          onChange={(value) => {
            setIndex(value);
            setEndIndex(value);
          }}
          options={sections.map((s) => ({
            value: s.location.index,
            label: locationLabel(s.location),
          }))}
        />
        <span>
          {sections.length} {sections[0]?.location.kind === "page" ? "页" : "个解析段落"}
        </span>
      </div>
      <article className="document-original" aria-label="解析原文">
        <h3>
          {locationLabel(
            section && {
              ...section.location,
              endIndex: Math.max(endIndex, section.location.index),
            },
          )}
        </h3>
        <p>
          {content ? (
            at >= 0 && excerpt ? (
              <>
                {content.slice(0, at)}
                <mark>{excerpt}</mark>
                {content.slice(at + excerpt.length)}
              </>
            ) : (
              content
            )
          ) : (
            "本页没有可提取文字。"
          )}
        </p>
      </article>
      <p className="document-reading-note">
        显示文件提取后的正文；PDF 保留页码，DOCX 和文本按解析段落定位。
      </p>
    </div>
  );
}
export function DocumentReader({
  projectId,
  kbId,
  documentId,
  versionId,
  location,
  excerpt,
  onClose,
}: {
  projectId: string;
  kbId: string;
  documentId: string;
  versionId?: string;
  location?: SourceLocation | null;
  excerpt?: string;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(versionId),
    [tab, setTab] = useState("source"),
    [anchor, setAnchor] = useState(location ?? { kind: "paragraph" as const, index: 1 });
  const [highlight, setHighlight] = useState(excerpt);
  const path = { projectId, kbId, id: documentId };
  const source = useQuery({
    queryKey: projectKey(
      projectId,
      "knowledgeBases",
      kbId,
      "source",
      documentId,
      selected ?? "latest",
    ),
    queryFn: ({ signal }) =>
      unwrap(api.getKnowledgeDocumentSource({ path, query: { versionId: selected }, signal })),
    gcTime: 0,
    staleTime: 0,
  });
  const versions = useQuery({
    queryKey: projectKey(projectId, "knowledgeBases", kbId, "versions", documentId),
    queryFn: ({ signal }) => unwrap(api.listKnowledgeDocumentVersions({ path, signal })),
    gcTime: 0,
  });
  const data = source.data;
  return (
    <Drawer
      open
      title={
        <>
          <FileSearchOutlined /> {data?.version.filename ?? "资料原文"}
        </>
      }
      size="min(1000px, 100vw)"
      onClose={onClose}
      destroyOnHidden
    >
      <QueryState label="资料原文" query={source}>
        {data && (
          <>
            <div className="document-reader-controls">
              <Tag color={data.version.active ? "green" : "default"}>
                v{data.version.version} · {data.version.active ? "当前检索版本" : "非当前检索版本"}
              </Tag>
              <span>{timestamp(data.version.createdAt)}</span>
            </div>
            {!data.version.active && (
              <Alert
                type="info"
                showIcon
                title="当前查看固定版本的原文，内容更新不会改变这份引用。"
              />
            )}
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: "source",
                  label: "原文阅读",
                  children: (
                    <SourceSections
                      key={`${data.version.id}-${anchor.index}-${anchor.endIndex}`}
                      sections={data.sections}
                      initialIndex={anchor.index}
                      initialEndIndex={anchor.endIndex}
                      excerpt={highlight}
                    />
                  ),
                },
                {
                  key: "chunks",
                  label: `检索分段 · ${data.chunks.length}`,
                  children: (
                    <Table
                      rowKey="ordinal"
                      dataSource={data.chunks}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                      columns={[
                        {
                          title: "位置",
                          width: 120,
                          render: (_, c) => (
                            <Button
                              type="link"
                              onClick={() => {
                                setAnchor(c.location);
                                setHighlight(c.content);
                                setTab("source");
                              }}
                            >
                              {locationLabel(c.location)}
                            </Button>
                          ),
                        },
                        {
                          title: "正文",
                          render: (_, c) => <p className="document-chunk-text">{c.content}</p>,
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: "versions",
                  label: (
                    <>
                      <HistoryOutlined /> 版本记录
                    </>
                  ),
                  children: (
                    <QueryState label="版本记录" query={versions}>
                      <Table
                        rowKey="id"
                        dataSource={versions.data}
                        pagination={{ pageSize: 8, showSizeChanger: false }}
                        columns={[
                          {
                            title: "版本",
                            render: (_, v) => (
                              <Button
                                type="link"
                                onClick={() => {
                                  setSelected(v.id);
                                  setAnchor({ kind: "paragraph", index: 1 });
                                  setHighlight(undefined);
                                  setTab("source");
                                }}
                              >
                                v{v.version}
                                {v.active ? " · 检索中" : ""}
                              </Button>
                            ),
                          },
                          { title: "文件", dataIndex: "filename" },
                          {
                            title: "状态",
                            render: (_, v) =>
                              ({
                                queued: "排队中",
                                processing: "索引中",
                                ready: "索引完成",
                                failed: "处理失败",
                              })[v.status],
                          },
                          { title: "更新于", render: (_, v) => timestamp(v.createdAt) },
                        ]}
                      />
                    </QueryState>
                  ),
                },
              ]}
            />
            {data.version.warnings.map((w) => (
              <Alert key={w} className="form-alert" type="warning" title={w} />
            ))}
            <details className="document-reading-note">
              <summary>内容标识</summary>
              <code>{data.version.contentHash}</code>
            </details>
          </>
        )}
      </QueryState>
    </Drawer>
  );
}
