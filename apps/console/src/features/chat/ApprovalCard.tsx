import { decideRunApproval, type ToolApprovalObservation } from "@platform/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import { useContext, useState } from "react";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { RunWorkspaceContext } from "./chat-context";

/** One open gate, answered in place. The decision is the platform's record:
 * the card reports what was sent and disables itself rather than assuming the
 * tool proceeded. */
export function ToolApprovalCard({
  projectId,
  runId,
  approval,
}: {
  projectId: string;
  runId: string;
  approval: ToolApprovalObservation;
}) {
  const client = useQueryClient();
  const [error, setError] = useState("");
  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      unwrap(
        decideRunApproval({
          path: { projectId, id: runId, callId: approval.toolCallId },
          body: { approved },
        }),
      ),
    onSuccess: () => {
      setError("");
      // The gate state and the run's own progress both change with this call.
      void client.invalidateQueries({
        queryKey: projectKey(projectId, "runs", runId, "workspace", "active"),
      });
      void client.invalidateQueries({
        queryKey: projectKey(projectId, "runs", runId, "workspace", "settled"),
      });
    },
    onError: (failure) =>
      setError(failure instanceof Error ? failure.message : "提交决定失败，请重试"),
  });
  return (
    <Alert
      className="chat-approval"
      type="warning"
      showIcon
      title={`需要确认：${approval.toolName} 会修改业务数据`}
      description={
        <div className="chat-approval-body">
          <p>
            这次调用已暂停，等待你决定。拒绝不会执行任何修改；未答复超过 10
            分钟后自动失效，同样不会执行。
          </p>
          {error && (
            <p className="chat-approval-error" role="alert">
              {error}
            </p>
          )}
          <div className="chat-approval-actions">
            <Button
              danger
              size="small"
              loading={decide.isPending && decide.variables === false}
              onClick={() => decide.mutate(false)}
            >
              拒绝执行
            </Button>
            <Button
              type="primary"
              size="small"
              loading={decide.isPending && decide.variables === true}
              onClick={() => decide.mutate(true)}
            >
              允许执行
            </Button>
          </div>
        </div>
      }
    />
  );
}

/** Every gate of the current run, in order: open ones first so a pending
 * decision is never hidden below settled history. */
export function ToolApprovalList({ projectId, runId }: { projectId: string; runId: string }) {
  const workspace = useContext(RunWorkspaceContext);
  const approvals = workspace?.approvals ?? [];
  const [showSettled, setShowSettled] = useState(false);
  if (!approvals.length) return null;
  const pending = approvals.filter((approval) => approval.status === "pending");
  const settled = approvals.filter((approval) => approval.status !== "pending");
  return (
    <div className="chat-approvals">
      {pending.map((approval) => (
        <ToolApprovalCard
          key={approval.toolCallId}
          projectId={projectId}
          runId={runId}
          approval={approval}
        />
      ))}
      {settled.length > 0 && (
        <details open={showSettled} onToggle={(event) => setShowSettled(event.currentTarget.open)}>
          <summary>已处理的写入确认 · {settled.length}</summary>
          <ul className="chat-approval-settled">
            {settled.map((approval) => (
              <li key={approval.toolCallId}>
                {approval.toolName} ·{" "}
                {approval.status === "approved"
                  ? "已允许"
                  : approval.status === "denied"
                    ? "已拒绝"
                    : "已失效，未执行"}
                {approval.waitedMs !== null && ` · 等待 ${Math.round(approval.waitedMs / 1000)}s`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
