import {
  defineToolkit,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import { type ReactNode, useContext } from "react";
import { Link } from "react-router";
import { AgentText } from "../../shared/ai/AgentText";
import { asRecord, readPlan } from "../../shared/ai/tool-content";
import { AgentPlan, ToolFallback } from "../../shared/assistant-ui";
import { conversationTracePath, projectPath } from "../../shared/navigation";
import { ChatToolContent } from "./ChatToolContent";
import { RunWorkspaceContext, ToolTraceContext } from "./chat-context";
import { ProcessIcon } from "./ProcessIcon";
import { processPreview, toolSummary } from "./process-summary";

export { ToolTraceContext } from "./chat-context";

function ToolTraceLink({ callId }: { callId: string }) {
  const context = useContext(ToolTraceContext);
  const runId = useAuiState((s) => s.message.metadata.custom.runId);
  const origin = useAuiState((s) => s.message.metadata.custom.originConversationId);
  if (!context || typeof runId !== "string") return null;
  return (
    <Link
      className="chat-tool-trace"
      aria-label="查看执行轨迹 →"
      title="查看执行轨迹"
      to={
        context.assistantMode
          ? `${projectPath(context.projectId, "runs", runId)}?recordId=${encodeURIComponent(`${runId}/tool:${callId}`)}`
          : `${conversationTracePath(context.projectId, typeof origin === "string" ? origin : context.conversationId, runId)}&recordId=${encodeURIComponent(`${runId}/tool:${callId}`)}`
      }
    >
      轨迹 ↗
    </Link>
  );
}
function CallDetails({ props }: { props: ToolCallMessagePartProps }) {
  return (
    <details className="chat-call-details">
      <summary>调用参数 · {props.toolName}</summary>
      <ToolFallback.Args argsText={props.argsText} />
    </details>
  );
}
function ToolHeading({
  props,
  label,
  summary,
  outcome,
  status = props.status,
}: {
  props: ToolCallMessagePartProps;
  label: string;
  summary: string;
  outcome?: string;
  status?: ToolCallMessagePartProps["status"];
}) {
  return (
    <div className="chat-process-heading">
      <ToolFallback.Trigger
        className="chat-process-trigger"
        toolName={props.toolName}
        icon={<ProcessIcon name={props.toolName} />}
        status={status}
        label={label}
        summary={summary}
        outcome={outcome}
      />
      <ToolTraceLink callId={props.toolCallId} />
    </div>
  );
}
function failureStatus(props: ToolCallMessagePartProps) {
  if (props.isError)
    return {
      type: "incomplete" as const,
      reason:
        props.status.type === "incomplete" && props.status.reason === "cancelled"
          ? ("cancelled" as const)
          : ("error" as const),
      error:
        (props.status.type === "incomplete" ? props.status.error : undefined) ??
        asRecord(props.result).error,
    };
  return props.status;
}
function statusLabel(status: ToolCallMessagePartProps["status"]) {
  return status.type === "running"
    ? "进行中"
    : status.type === "incomplete"
      ? status.reason === "cancelled"
        ? "已取消"
        : "执行失败"
      : status.type === "requires-action"
        ? "等待确认"
        : "";
}
export const PlanToolCard: ToolCallMessagePartComponent = (props) => {
  const plan = readPlan(props.result);
  if (!plan || props.isError || props.status.type === "requires-action")
    return <ResultToolCard {...props} />;
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const blocked = plan.items.filter((item) => item.status === "blocked").length;
  return (
    <section className="chat-plan-card" aria-label={`任务计划版本 ${plan.revision}`}>
      <ToolFallback.Root className="chat-process">
        <ToolHeading
          props={props}
          label="更新计划"
          summary={plan.title}
          outcome={`v${plan.revision} · ${completed}/${plan.items.length} 完成${blocked ? ` · ${blocked} 受阻` : ""}`}
        />
        <ToolFallback.Content>
          <AgentPlan title={plan.title} revision={plan.revision} items={plan.items} />
          <p className="chat-process-note">{plan.explanation}</p>
          <CallDetails props={props} />
        </ToolFallback.Content>
      </ToolFallback.Root>
    </section>
  );
};
export const SubagentToolCard: ToolCallMessagePartComponent = (props) => {
  const live = useContext(RunWorkspaceContext)?.subagents.find(
    (s) => s.parentToolCallId === props.toolCallId,
  );
  const args = asRecord(props.args),
    result = asRecord(props.result);
  const state = result.status ?? live?.status;
  const failed = ["failed", "cancelled", "rejected"].includes(String(state));
  const status = failed
    ? {
        type: "incomplete" as const,
        reason: state === "cancelled" ? ("cancelled" as const) : ("error" as const),
        error: result.errorCode,
      }
    : failureStatus(props);
  const label =
    state === "queued"
      ? "排队中"
      : statusLabel(status) || (state === "succeeded" ? "已完成" : "结果未记录");
  if (props.status.type === "requires-action") return <ToolFallback {...props} />;
  const name = String(args.name ?? "分配任务");
  const preview =
    state === "succeeded" && typeof result.text === "string" && result.text.trim()
      ? processPreview(result.text, true)
      : processPreview(String(args.task ?? "正在接收任务…"));
  return (
    <section
      className="chat-subagent-card"
      aria-label={`子代理 · ${name}`}
      data-failed={failed || props.isError}
    >
      <ToolFallback.Root className="chat-process" data-failed={status.type === "incomplete"}>
        <ToolHeading
          props={props}
          status={status}
          label="子代理"
          summary={`${name} · ${preview}`}
          outcome={state === "rejected" ? "未执行" : label}
        />
        <ToolFallback.Content>
          <p className="chat-process-note">{String(args.task ?? "")}</p>
          {live && (
            <p className="chat-process-note" role="status">
              {live.completedTools}/{live.toolCount} 个工具完成 · {live.activity || label}
            </p>
          )}
          {live?.outputText && typeof result.text !== "string" && (
            <AgentText text={live.outputText} className="chat-subagent-result" />
          )}
          <ToolFallback.Error status={status} />
          {typeof result.text === "string" && (
            <AgentText text={result.text} className="chat-subagent-result" />
          )}
          <CallDetails props={props} />
          <details className="chat-call-details">
            <summary>完整执行记录</summary>
            <ToolFallback.Result result={props.result} />
          </details>
        </ToolFallback.Content>
      </ToolFallback.Root>
    </section>
  );
};
export function ResultToolCard(props: ToolCallMessagePartProps & { children?: ReactNode }) {
  if (props.status.type === "requires-action") return <ToolFallback {...props} />;
  const status = failureStatus(props),
    result = asRecord(props.result);
  const scriptFailed =
    props.toolName === "run_skill_script" &&
    typeof result.exitCode === "number" &&
    result.exitCode !== 0;
  const displayStatus = scriptFailed
    ? { type: "incomplete" as const, reason: "error" as const }
    : status;
  const presentation = toolSummary(props.toolName, props.args, props.result);
  return (
    <ToolFallback.Root className="chat-process" data-failed={displayStatus.type === "incomplete"}>
      <ToolHeading
        props={props}
        {...presentation}
        status={displayStatus}
        outcome={statusLabel(displayStatus) || presentation.outcome}
      />
      <ToolFallback.Content>
        <ToolFallback.Error status={displayStatus} />
        {props.isError ? (
          <details className="chat-call-details">
            <summary>完整执行记录</summary>
            <ToolFallback.Result result={props.result} />
          </details>
        ) : (
          (props.children ?? (
            <ChatToolContent toolName={props.toolName} args={props.args} result={props.result} />
          ))
        )}
        <CallDetails props={props} />
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
}

// Render-only backend entries. Schemas, authorization and execution stay in Runtime.
export const chatToolkit = defineToolkit({
  update_plan: { type: "backend", display: "standalone", render: PlanToolCard },
  delegate_task: { type: "backend", display: "standalone", render: SubagentToolCard },
  run_skill_script: { type: "backend", render: ResultToolCard },
});
