import { ThunderboltOutlined } from "@ant-design/icons";
import type {
  Model,
  WorkflowAsset,
  WorkflowAssetInput,
  WorkflowCapability,
  WorkflowGeneration,
} from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App as AntApp, Button, Form, Input, Modal, Select } from "antd";
import { useEffect, useState } from "react";
import { v4 as uuid } from "uuid";
import { timestamp, unwrap } from "../api";
import { useProjectRefresh } from "../data/ProjectData";
import { QueryState } from "../data/QueryState";
import { workflowQueries } from "../data/workflows";
import { useLifetime } from "../useLifetime";
import { WorkflowCanvas } from "../WorkflowCanvas";
import { describeChanges } from "../workflow-model";
import { Status } from "./Status";
export function WorkflowAuthoring({
  asset,
  draft,
  catalog,
  models,
  dirty,
  busy,
  guard,
  onAccepted,
  onReviewChange,
}: {
  asset: WorkflowAsset;
  draft: WorkflowAssetInput;
  catalog: WorkflowCapability[];
  models: Model[];
  dirty: boolean;
  busy: boolean;
  guard(action: (signal: AbortSignal) => Promise<void>): Promise<void>;
  onAccepted(asset: WorkflowAsset, signal: AbortSignal): Promise<void>;
  onReviewChange(open: boolean): void;
}) {
  const { message } = AntApp.useApp(),
    lifetime = useLifetime(),
    refresh = useProjectRefresh(),
    client = useQueryClient();
  const generationsOptions = workflowQueries.generations(asset.projectId, asset.id),
    generationsQuery = useQuery(generationsOptions),
    generations = generationsQuery.data ?? [];
  const [intent, setIntent] = useState(""),
    [modelId, setModelId] = useState(models.find((model) => model.kind === "chat")?.id),
    [review, setReview] = useState<WorkflowGeneration | null>(null);
  useEffect(() => {
    onReviewChange(!!review);
    return () => onReviewChange(false);
  }, [review, onReviewChange]);
  const path = { projectId: asset.projectId, id: asset.id },
    projectPath = { projectId: asset.projectId },
    latestGeneration = generations[0],
    generating = generations.some((item) => ["queued", "running"].includes(item.status));
  const action = (fn: (signal: AbortSignal) => Promise<void>) =>
    guard((signal) => fn(AbortSignal.any([signal, lifetime()])));
  return (
    <>
      <QueryState label="AI 编排记录" query={generationsQuery}>
        <aside className="workflow-ai-panel">
          <p>描述希望完成的任务，或告诉我如何修改当前流程。</p>
          <Form layout="vertical" component="div">
            <Form.Item label="编排模型" htmlFor="workflow-author-model">
              <Select
                id="workflow-author-model"
                value={modelId}
                options={models
                  .filter((m) => m.kind === "chat")
                  .map((m) => ({ label: m.name, value: m.id }))}
                onChange={setModelId}
              />
            </Form.Item>
            <Form.Item label="业务需求" htmlFor="workflow-intent">
              <Input.TextArea
                id="workflow-intent"
                value={intent}
                autoSize={{ minRows: 5, maxRows: 10 }}
                maxLength={8000}
                placeholder="输入订单号，查询订单，结合知识库生成带来源的采购报告。"
                onChange={(e) => setIntent(e.target.value)}
              />
            </Form.Item>
            <Button
              type="primary"
              block
              icon={<ThunderboltOutlined />}
              loading={generating}
              disabled={busy || dirty || !modelId || !intent.trim() || generating}
              onClick={() =>
                void action(async (signal) => {
                  const generation = await unwrap(
                    api.generateWorkflow({
                      path,
                      signal,
                      body: {
                        baseRevision: asset.revision,
                        modelId: modelId ?? "",
                        intent,
                        requestId: uuid(),
                      },
                    }),
                    signal,
                  );
                  client.setQueryData(generationsOptions.queryKey, (items = []) => [
                    generation,
                    ...items,
                  ]);
                  void refresh("workflows");
                })
              }
            >
              生成完整候选
            </Button>
          </Form>
          {dirty && <p className="workflow-hint">先保存当前修改，再让 AI 基于最新草稿编排。</p>}
          <p className="workflow-hint">
            AI 只使用当前项目已有的能力。候选需由你接受，发布后才成为可调用版本。
          </p>
          {latestGeneration && (
            <div className="workflow-generation-card">
              <div>
                <strong>最近一次编排</strong>
                <Status value={latestGeneration.status} />
              </div>
              <p className="workflow-generation-intent">{latestGeneration.intent}</p>
              {latestGeneration.candidate && (
                <details>
                  <summary>编排说明</summary>
                  <p>{latestGeneration.candidate.explanation}</p>
                </details>
              )}
              {latestGeneration.issues.map((i) => (
                <p className="workflow-error" key={`${i.nodeId}-${i.message}`}>
                  {i.message}
                </p>
              ))}
              {latestGeneration.errorCode && !latestGeneration.issues.length && (
                <p className="workflow-error">{latestGeneration.errorCode}</p>
              )}
              {latestGeneration.candidate && (
                <Button block onClick={() => setReview(structuredClone(latestGeneration))}>
                  预览候选与修改
                </Button>
              )}
              {["queued", "running"].includes(latestGeneration.status) && (
                <Button
                  block
                  onClick={() =>
                    void action(async (signal) => {
                      await unwrap(
                        api.cancelWorkflowGeneration({
                          path: { ...projectPath, id: latestGeneration.id },
                          body: {},
                          signal,
                        }),
                        signal,
                      );
                      await refresh("workflows");
                    })
                  }
                >
                  取消生成
                </Button>
              )}
            </div>
          )}
          {generations.length > 1 && (
            <details>
              <summary>历史编排记录（{generations.length}）</summary>
              {generations.slice(1).map((g) => (
                <div className="workflow-history-row" key={g.id}>
                  <Status value={g.status} />
                  <Button
                    type="link"
                    disabled={!g.candidate}
                    onClick={() => setReview(structuredClone(g))}
                  >
                    {timestamp(g.createdAt)} · 修订 {g.baseRevision}
                  </Button>
                </div>
              ))}
            </details>
          )}
        </aside>
      </QueryState>
      <Modal
        title="审阅 AI 工作流候选"
        open={!!review}
        onCancel={() => setReview(null)}
        width="min(1200px, 96vw)"
        okText={review?.acceptedRevision ? "已接受" : "接受候选"}
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            busy ||
            dirty ||
            review?.status !== "succeeded" ||
            !!review?.acceptedRevision ||
            review?.baseRevision !== asset.revision,
        }}
        onOk={() =>
          void action(async (signal) => {
            if (!review) return;
            const saved = await unwrap(
              api.acceptWorkflowGeneration({
                path: { ...projectPath, id: review.id },
                signal,
                body: { baseRevision: review.baseRevision },
              }),
              signal,
            );
            await onAccepted(saved, signal);
            signal.throwIfAborted();
            setReview(null);
            void refresh("workflows");
            message.success("候选已接受，流程布局待保存，尚未发布");
          })
        }
      >
        {review?.candidate && (
          <div className="workflow-candidate">
            <p>{review.candidate.explanation}</p>
            {review.baseRevision !== asset.revision && (
              <Alert
                type="warning"
                title="当前草稿已变化，此候选不能直接覆盖"
                description="请保留修改，重新基于最新草稿生成候选。"
              />
            )}
            <ul>
              {describeChanges(draft.definition, review.candidate.definition).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <WorkflowCanvas
              key={review.id}
              initial={{
                ...draft,
                definition: review.candidate.definition,
                layout: {},
              }}
              onChange={() => {}}
              onSelect={() => {}}
              catalog={catalog}
              readonly
            />
            <details>
              <summary>查看节点、变量与资源的完整变更</summary>
              <div className="workflow-schema-grid">
                <pre>{JSON.stringify(draft.definition, null, 2)}</pre>
                <pre>{JSON.stringify(review.candidate.definition, null, 2)}</pre>
              </div>
            </details>
          </div>
        )}
      </Modal>
    </>
  );
}
