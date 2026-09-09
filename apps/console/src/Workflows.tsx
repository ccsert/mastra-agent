import { BranchesOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { Model, WorkflowAsset } from "@platform/sdk";
import { Button, Empty, Tag } from "antd";
import { useState } from "react";
import { timestamp } from "./api";
import { useProjectPages, useProjectRefresh } from "./data/ProjectData";
import { PageMore, pageItems } from "./data/pages";
import { QueryState } from "./data/QueryState";
import type { RegisterGuard } from "./workflows/draft";
import { WorkflowCreate } from "./workflows/WorkflowCreate";
import { WorkflowEditor } from "./workflows/WorkflowEditor";
import "./workflows.css";
export function WorkflowWorkspace({
  projectId,
  models,
  registerGuard,
}: {
  projectId: string;
  models: Model[];
  registerGuard: RegisterGuard;
}) {
  const [asset, setAsset] = useState<WorkflowAsset | null>(null),
    [createOpen, setCreateOpen] = useState(false);
  const itemsQuery = useProjectPages("workflows", { enabled: !asset }),
    items = pageItems(itemsQuery.data),
    refresh = useProjectRefresh();
  if (asset)
    return (
      <WorkflowEditor
        key={asset.id}
        initial={asset}
        models={models}
        registerGuard={registerGuard}
        onBack={() => {
          setAsset(null);
          void refresh("workflows");
        }}
      />
    );
  return (
    <>
      <div className="workflow-intro">
        <div>
          <span className="eyebrow">从业务意图到可重复执行的流程</span>
          <h2>把团队能力组合成工作流</h2>
          <p>用自然语言生成流程，连接 Agent、知识库与业务工具，审阅后发布给团队和业务系统使用。</p>
        </div>
        <div className="workflow-actions">
          <Button
            icon={<ReloadOutlined />}
            aria-label="刷新工作流"
            onClick={() => void refresh("workflows")}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            创建工作流
          </Button>
        </div>
      </div>
      <QueryState label="工作流" query={itemsQuery}>
        {items.length ? (
          <div className="workflow-grid">
            {items.map((item) => (
              <button
                type="button"
                className="workflow-asset-card"
                key={item.id}
                onClick={() => setAsset(item)}
              >
                <span className="workflow-asset-icon">
                  <BranchesOutlined />
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.description || "将 Agent 和业务工具串联为可重复运行的任务。"}</p>
                  <div className="workflow-card-meta">
                    <Tag>{item.publishedVersion ? `已发布 v${item.publishedVersion}` : "草稿"}</Tag>
                    <span>{item.definition.nodes.length} 个节点</span>
                    <span>{timestamp(item.createdAt)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="blank-state">
            <Empty description="还没有工作流">
              <Button onClick={() => setCreateOpen(true)}>从一句业务需求开始</Button>
            </Empty>
          </div>
        )}
        <PageMore query={itemsQuery} count={items.length} label="工作流" />
      </QueryState>
      {createOpen && (
        <WorkflowCreate
          projectId={projectId}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setAsset(created);
          }}
        />
      )}
    </>
  );
}
