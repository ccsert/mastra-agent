import { BookOutlined, PlusOutlined } from "@ant-design/icons";
import type { Model } from "@platform/sdk";
import { Alert, Button } from "antd";
import { useState } from "react";
import { useProjectAccess } from "../../shared/access";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import type { ResourceSelection } from "../../shared/navigation";
import { KnowledgeCreate } from "./KnowledgeCreate";
import { KnowledgeDetails } from "./KnowledgeDetails";
export function KnowledgeWorkspace({
  projectId,
  models,
  onConfigureModels,
  selectedId,
  onSelect,
}: ResourceSelection & {
  projectId: string;
  models: Model[];
  onConfigureModels(): void;
}) {
  const canEdit = useProjectAccess()?.permissions.includes("resource.edit") ?? false;
  const basesQuery = useProjectQuery("knowledgeBases", { poll: 2500 }),
    bases = basesQuery.data ?? [];
  const [creating, setCreating] = useState(false);
  const kb = bases.find((base) => base.id === selectedId);
  return (
    <>
      <div className="knowledge-workspace">
        <aside className="knowledge-list panel">
          <div className="knowledge-list-header">
            <strong>
              项目知识库 <span>{bases.length}</span>
            </strong>
            <Button
              disabled={!canEdit}
              type="text"
              aria-label="创建知识库"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            />
          </div>
          <QueryState label="知识库" query={basesQuery}>
            {bases.map((k) => (
              <button
                type="button"
                key={k.id}
                className={`knowledge-item ${kb?.id === k.id ? "selected" : ""}`}
                onClick={() => onSelect(k.id)}
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
                <Button disabled={!canEdit} type="primary" onClick={() => setCreating(true)}>
                  创建知识库
                </Button>
              </div>
            )}
          </QueryState>
        </aside>
        <section className="knowledge-detail panel">
          {selectedId && basesQuery.data && !kb ? (
            <Alert type="error" title="知识库不存在或无权访问" />
          ) : kb ? (
            <KnowledgeDetails key={kb.id} kb={kb} models={models} />
          ) : (
            basesQuery.data && (
              <div className="knowledge-welcome">
                <BookOutlined />
                <h2>{bases.length ? "选择一个知识库" : "让 Agent 使用团队的知识"}</h2>
                <p>接入向量模型，建立知识库，上传资料。通过检索测试查看来源，再绑定到 Agent。</p>
                <Button disabled={!canEdit} onClick={() => setCreating(true)} type="primary">
                  新建知识库
                </Button>
              </div>
            )
          )}
        </section>
      </div>
      {creating && canEdit && (
        <KnowledgeCreate
          projectId={projectId}
          models={models}
          onConfigureModels={onConfigureModels}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            onSelect(item.id);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}
