import { useAuiState } from "@assistant-ui/react";
import { getRunWorkspace } from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ClipboardCheck, FolderOpen, Gauge } from "lucide-react";
import { type PropsWithChildren, useContext, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { AgentText } from "../../shared/ai/AgentText";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { conversationTracePath } from "../../shared/navigation";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactCanvasContext } from "./artifact-context";
import { RunWorkspaceContext, ToolTraceContext } from "./chat-context";
import { toolSummary } from "./process-summary";
import { formatRunError } from "./run-status";

const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  rejected: "未执行",
};
export function ChatTurn({ children }: PropsWithChildren) {
  const context = useContext(ToolTraceContext);
  const updateFiles = useContext(ArtifactCanvasContext)?.updateFiles;
  const parts = useAuiState((s) => s.message.parts);
  const status = useAuiState((s) => s.message.status?.type);
  const isLast = useAuiState((s) => s.thread.messages.at(-1)?.id === s.message.id);
  const runId = useAuiState((s) => s.message.metadata.custom.runId);
  const origin = useAuiState((s) => s.message.metadata.custom.originConversationId);
  const savedStatus = useAuiState((s) => s.message.metadata.custom.runStatus);
  const savedError = useAuiState((s) => s.message.metadata.custom.errorCode);
  const running = status === "running";
  const tools = parts.filter((p) => p.type === "tool-call");
  const reasoning = parts.filter((p) => p.type === "reasoning").length;
  const failed = tools.filter(
    (p) => p.isError || (p.status.type === "incomplete" && p.status.reason === "error"),
  ).length;
  // Never auto-collapse a process the user was watching when the stream finishes.
  const [expanded, setExpanded] = useState<boolean | undefined>(running ? true : undefined);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const processId = useId(),
    workspaceId = useId();
  const projectId = context?.projectId ?? "",
    id = typeof runId === "string" ? runId : "";
  const workspace = useQuery({
    queryKey: projectKey(projectId, "runs", id, "workspace", running ? "active" : "settled"),
    queryFn: async ({ signal }) => {
      const value = await unwrap(getRunWorkspace({ path: { projectId, id }, signal }));
      if (
        !Array.isArray(value?.artifacts) ||
        !Array.isArray(value?.skills) ||
        !Array.isArray(value?.subagents)
      )
        throw new Error("工作区响应格式不正确");
      return value;
    },
    enabled: !context?.assistantMode && !!id && !!projectId && (isLast || running || workspaceOpen),
    refetchInterval: running ? 1500 : false,
    placeholderData: (previous) => previous,
    staleTime: running ? 0 : Infinity,
  });
  // Status is part of the query lifecycle: fetch the committed final workspace
  // even if the last polling tick happened just before the run completed.
  const data = workspace.data;
  useEffect(() => {
    if (data) updateFiles?.(id, data.artifacts);
  }, [data, id, updateFiles]);
  const active = tools.findLast((p) => p.status.type === "running");
  const showProcess = !!(tools.length || reasoning);
  const outcome =
    savedStatus === "failed"
      ? "执行失败"
      : savedStatus === "cancelled"
        ? "已停止"
        : failed
          ? `${failed} 次工具失败`
          : running
            ? active
              ? `正在${toolSummary(active.toolName, {}, {}).label}`
              : "处理中"
            : status === "incomplete"
              ? "执行已结束"
              : "处理完成";
  const countLabel = data
    ? [
        data.subagents.length && `${data.subagents.length} 个子任务`,
        data.skills.length && `${data.skills.length} 个 Skill`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <RunWorkspaceContext.Provider value={data}>
      <div className="chat-turn" data-process-expanded={expanded ?? failed > 0}>
        {(savedStatus === "failed" || savedStatus === "cancelled") && (
          <p className="chat-interrupted" role="status">
            {savedStatus === "cancelled" ? "此轮已停止" : "此轮执行失败"}
            {typeof savedError === "string" ? ` · ${formatRunError(savedError)}` : ""}
            。以下为已记录的部分内容，完整过程可在轨迹中查看。
          </p>
        )}
        {showProcess && (
          <button
            type="button"
            className="chat-turn-summary"
            aria-expanded={expanded ?? failed > 0}
            aria-controls={processId}
            onClick={() => setExpanded(!(expanded ?? failed > 0))}
          >
            <ChevronDown size={14} />
            <strong>{outcome}</strong>
            <span>
              {[reasoning && `${reasoning} 段思考`, tools.length && `${tools.length} 次工具`]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <small>{(expanded ?? failed > 0) ? "收起过程" : "展开过程"}</small>
          </button>
        )}
        <div id={processId} className="chat-turn-content">
          {children}
        </div>
        {!!data?.artifacts.length && (
          <section className="chat-artifact-list" aria-label="本轮产物">
            {data.artifacts.map((file) => (
              <ArtifactCard
                key={file.id}
                file={file}
                files={data.artifacts}
                projectId={projectId}
                runId={id}
              />
            ))}
          </section>
        )}
        {!!id && !context?.assistantMode && (
          <div className="chat-turn-workspace">
            <button
              type="button"
              className="chat-workspace-trigger"
              aria-expanded={workspaceOpen}
              aria-controls={workspaceId}
              onClick={() => setWorkspaceOpen(!workspaceOpen)}
            >
              <FolderOpen size={14} />
              {countLabel || (data?.artifacts.length ? "本轮工作记录" : "成果与子任务")}
              <ChevronDown size={12} />
            </button>
            {workspaceOpen && (
              <section id={workspaceId} className="chat-workspace-content" aria-label="本轮工作区">
                {workspace.isPending && <p role="status">正在读取本轮成果…</p>}
                {workspace.isError && (
                  <p role="alert">
                    无法读取工作区。
                    <button type="button" onClick={() => void workspace.refetch()}>
                      重试
                    </button>
                  </p>
                )}
                {data && (
                  <>
                    {!!data.feedback?.length && (
                      <details className="chat-task-progress">
                        <summary>本轮补充要求 · {data.feedback.length}</summary>
                        {data.feedback.map((item) => (
                          <div key={item.id}>
                            <p>{item.text}</p>
                            <small>
                              {item.readAt
                                ? "执行器已读取，请结合结果核对落实情况"
                                : running
                                  ? "等待执行器读取"
                                  : "本轮结束前未读取，可在下一轮继续"}
                            </small>
                          </div>
                        ))}
                      </details>
                    )}
                    {data.execution && (
                      <p
                        className="chat-execution-budget"
                        title="已返回用量的请求按实际 Token 结算，未返回用量的请求仍保留预估额度。"
                      >
                        <Gauge size={14} />
                        <span>
                          模型请求 {data.execution.modelCalls}/{data.execution.maxModelCalls} ·
                          已用及预留 {Math.ceil(data.execution.reservedTokens / 1000)}k/
                          {Math.ceil(data.execution.maxTokens / 1000)}k Token
                          {data.execution.recoveries > 0
                            ? ` · 恢复 ${data.execution.recoveries} 次`
                            : ""}
                        </span>
                      </p>
                    )}
                    {data.taskState && (
                      <details className="chat-task-progress">
                        <summary>
                          <ClipboardCheck size={14} />
                          工作进度 · v{data.taskState.revision}
                        </summary>
                        <p>{data.taskState.objective}</p>
                        <AgentText text={data.taskState.progress} />
                        <ul>
                          {data.taskState.nextSteps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ul>
                        <small>进度由 Agent 记录，完成情况请结合验收证据核对。</small>
                      </details>
                    )}
                    {!!data.skills.length && (
                      <div className="chat-workspace-skills">
                        {data.skills.map((skill) => (
                          <span
                            key={`${skill.subagentId}:${skill.versionId}`}
                            title={`加载于 ${skill.loadedAt}${skill.subagentId ? " · 子代理" : ""}`}
                          >
                            {skill.name}{" "}
                            <small>
                              v{skill.version} ·{" "}
                              {skill.source === "selected" ? "已按指定加载" : "Agent 已加载"}
                            </small>
                          </span>
                        ))}
                      </div>
                    )}
                    {!!data.subagents.length && (
                      <div className="chat-child-list">
                        {data.subagents.map((child) => (
                          <details key={child.id} className="chat-child-task">
                            <summary>
                              <strong>{child.name}</strong>
                              <span>
                                {statusNames[child.status]} · 工具 {child.completedTools}/
                                {child.toolCount}
                              </span>
                            </summary>
                            <p className="chat-process-note">{child.task}</p>
                            {child.status === "running" && (
                              <p role="status" className="chat-process-note">
                                {child.activity || "正在执行任务…"}
                              </p>
                            )}
                            {child.errorCode && <p role="alert">{child.errorCode}</p>}
                            {child.outputText && <AgentText text={child.outputText} />}
                            {context && (
                              <Link
                                to={`${conversationTracePath(projectId, typeof origin === "string" ? origin : context.conversationId, id)}&recordId=${encodeURIComponent(`${id}/tool:${child.parentToolCallId}`)}`}
                              >
                                查看子任务完整轨迹 ↗
                              </Link>
                            )}
                          </details>
                        ))}
                      </div>
                    )}
                    {!data.artifacts.length && !data.subagents.length && !data.skills.length && (
                      <p className="chat-process-note">
                        {running
                          ? "本轮尚未产生文件或子任务。"
                          : "本轮没有可下载的工具结果、子任务或已记录的 Skill 加载事件。"}
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </RunWorkspaceContext.Provider>
  );
}
