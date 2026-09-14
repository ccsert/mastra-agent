import {
  ArrowRightOutlined,
  CheckOutlined,
  LockOutlined,
  NodeIndexOutlined,
} from "@ant-design/icons";
import type { AssistantProposal } from "@platform/sdk";
import { Alert, Button, Tag } from "antd";

const labels = {
  pending: "待审阅",
  applying: "应用中",
  succeeded: "已完成",
  failed: "需要处理",
  dismissed: "已放弃",
};
export function ProposalCard({
  proposal,
  busy,
  error,
  onApply,
  onAdjust,
  onNavigate,
}: {
  proposal: AssistantProposal;
  busy: boolean;
  error?: string;
  onApply(dismiss: boolean): void;
  onAdjust(): void;
  onNavigate(page: string, id?: string, projectId?: string): void;
}) {
  const sensitive = proposal.actions.some((a) => a.risk !== "draft");
  const stale = Date.parse(proposal.expiresAt) < Date.now();
  return (
    <article className={`assistant-proposal is-${proposal.status}`}>
      <header>
        <span className="assistant-eyebrow">
          {sensitive ? (
            <>
              <LockOutlined /> 需要单独确认
            </>
          ) : (
            <>
              <NodeIndexOutlined /> 资源变更
            </>
          )}
        </span>
        <Tag
          color={
            proposal.status === "succeeded"
              ? "green"
              : proposal.status === "failed"
                ? "orange"
                : "default"
          }
        >
          {labels[proposal.status]}
        </Tag>
      </header>
      <h3>{proposal.title}</h3>
      <p className="assistant-proposal-reason">{proposal.reason}</p>
      <ol className="assistant-action-list">
        {proposal.actions.map((action, index) => (
          <li key={action.key}>
            <span className={`assistant-step status-${action.status}`}>
              {action.status === "succeeded" ? <CheckOutlined /> : index + 1}
            </span>
            <div>
              <strong>{action.label}</strong>
              {typeof action.input.name === "string" && <p>{action.input.name}</p>}
              {typeof action.input.description === "string" && <p>{action.input.description}</p>}
              <details>
                <summary>检查完整配置</summary>
                <pre>{JSON.stringify(action.input, null, 2)}</pre>
              </details>
              {action.error && <Alert type="error" title={action.error} />}
              {action.status === "succeeded" &&
                action.result &&
                typeof action.result.page === "string" && (
                  <Button
                    size="small"
                    type="link"
                    icon={<ArrowRightOutlined />}
                    onClick={() =>
                      onNavigate(
                        String(action.result?.page),
                        typeof action.result?.resourceId === "string"
                          ? action.result.resourceId
                          : undefined,
                        typeof action.result?.projectId === "string"
                          ? action.result.projectId
                          : undefined,
                      )
                    }
                  >
                    查看结果
                  </Button>
                )}
            </div>
          </li>
        ))}
      </ol>
      {error && <Alert type="error" title={error} />}
      {proposal.status === "applying" && (
        <p className="assistant-proposal-note">
          任务由服务器执行。若长时间未更新，请检查资源结果；重复点击不会重新创建。
        </p>
      )}
      {proposal.status === "failed" && (
        <p className="assistant-proposal-note">
          已成功的步骤保留。请让助手检查现状，再处理剩余步骤。
        </p>
      )}
      {proposal.status === "pending" && (
        <footer>
          <Button type="primary" loading={busy} disabled={stale} onClick={() => onApply(false)}>
            {stale
              ? "预览已过期"
              : sensitive
                ? "确认此项操作"
                : `应用 ${proposal.actions.length} 项更改`}
          </Button>
          <Button type="text" disabled={busy} onClick={onAdjust}>
            调整方案
          </Button>
          <Button type="text" disabled={busy} onClick={() => onApply(true)}>
            放弃
          </Button>
        </footer>
      )}
    </article>
  );
}
