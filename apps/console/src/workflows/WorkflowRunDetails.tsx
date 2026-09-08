import type { WorkflowNode } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer } from "antd";
import { useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { timestamp, unwrap } from "../api";
import { useProjectRefresh } from "../data/ProjectData";
import { QueryState } from "../data/QueryState";
import { workflowQueries } from "../data/workflows";
import { useOperation } from "../useOperation";
import { nodeNames } from "../workflow-model";
import { Status } from "./Status";
export function WorkflowRunDetails({
  projectId,
  workflowId,
  id,
  onClose,
}: {
  projectId: string;
  workflowId: string;
  id: string;
  onClose(): void;
}) {
  const { busy, error, run: guard } = useOperation(),
    refresh = useProjectRefresh();
  const projectPath = { projectId };
  const runQuery = useQuery(workflowQueries.run(projectId, id)),
    detail = runQuery.data;
  const nodesQuery = useQuery({
    ...workflowQueries.nodes(projectId, id),
    refetchInterval: detail && ["queued", "running"].includes(detail.status) ? 800 : false,
  });
  const nodeRuns = nodesQuery.data ?? [];
  // A terminal run can arrive before the last node poll; always fetch the final node snapshot.
  const client = useQueryClient(),
    status = detail?.status;
  useEffect(() => {
    if (status && !["queued", "running"].includes(status))
      void client.invalidateQueries({ queryKey: workflowQueries.nodes(projectId, id).queryKey });
  }, [status, client, projectId, id]);
  return (
    <Drawer
      title="工作流运行详情"
      open
      onClose={() => onClose()}
      size="min(920px, 100vw)"
      destroyOnHidden
    >
      {error && <Alert title={error} type="error" />}
      <QueryState label="工作流运行详情" query={runQuery}>
        {detail && (
          <>
            <div className="workflow-run-summary">
              <div>
                <h3>{detail.name}</h3>
                <span className="muted">
                  v{detail.version} · {timestamp(detail.createdAt)}
                </span>
              </div>
              <Status value={detail.status} />
              {["queued", "running"].includes(detail.status) && (
                <Button
                  danger
                  loading={busy}
                  onClick={() =>
                    void guard(async (signal) => {
                      await unwrap(
                        api.cancelWorkflowRun({
                          path: { ...projectPath, id: detail.id },
                          body: {},
                          signal,
                        }),
                        signal,
                      );
                      await refresh("workflows");
                    })
                  }
                >
                  取消运行
                </Button>
              )}
            </div>
            {detail.errorCode && <Alert type="error" title={`运行停止：${detail.errorCode}`} />}
            {detail.output && (
              <section className="workflow-result">
                <h3>执行结果</h3>
                <div className="workflow-report">
                  {typeof detail.output.report === "string" ? (
                    <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]}>
                      {detail.output.report.trim()}
                    </Markdown>
                  ) : (
                    <pre>{JSON.stringify(detail.output, null, 2)}</pre>
                  )}
                </div>
              </section>
            )}
            <QueryState label="节点执行记录" query={nodesQuery}>
              <div className="workflow-node-timeline">
                {nodeRuns.map((node) => (
                  <details className={`workflow-node-record ${node.status}`} key={node.nodeId}>
                    <summary>
                      <span>
                        <strong>{node.label}</strong>
                        <small>{nodeNames[node.type as WorkflowNode["type"]] ?? node.type}</small>
                      </span>
                      <Status value={node.status} />
                    </summary>
                    {node.errorCode && <p className="workflow-error">{node.errorCode}</p>}
                    <div className="workflow-schema-grid">
                      <div>
                        <h4>输入</h4>
                        <pre>{JSON.stringify(node.input, null, 2)}</pre>
                      </div>
                      <div>
                        <h4>输出</h4>
                        <pre>{JSON.stringify(node.output, null, 2)}</pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </QueryState>
            <details>
              <summary>调用信息</summary>
              <pre>
                {JSON.stringify(
                  {
                    workflowId: workflowId,
                    releaseId: detail.releaseId,
                    runId: detail.id,
                    input: detail.input,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        )}
      </QueryState>
    </Drawer>
  );
}
