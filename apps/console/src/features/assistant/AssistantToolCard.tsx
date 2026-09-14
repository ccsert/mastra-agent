import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ControlOutlined,
  FileTextOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Button } from "antd";
import { createContext, useContext } from "react";
import { ToolCard } from "../chat/index";
export const AssistantNavigation = createContext<(page: string, resourceId?: string) => void>(
  () => {},
);
export const AssistantToolCard: ToolCallMessagePartComponent = (props) => {
  const navigate = useContext(AssistantNavigation);
  if (!props.toolName.startsWith("platform_") || !props.result || props.isError)
    return <ToolCard {...props} />;
  const result = props.result as Record<string, unknown>;
  if (["platform_ui", "platform_app"].includes(props.toolName)) {
    const details =
      result.result && typeof result.result === "object"
        ? (result.result as Record<string, unknown>)
        : undefined;
    const output =
      details?.output && typeof details.output === "object"
        ? (details.output as Record<string, unknown>)
        : undefined;
    const changes = Array.isArray(output?.changes)
      ? output.changes.filter(
          (
            value,
          ): value is {
            target: string;
            label: string;
            before: string;
            after: string;
            truncated?: boolean;
          } =>
            !!value &&
            typeof value === "object" &&
            typeof value.target === "string" &&
            typeof value.label === "string" &&
            typeof value.before === "string" &&
            typeof value.after === "string",
        )
      : [];
    const failed = ["failed", "unknown", "cancelled"].includes(String(result.status));
    const title =
      result.type === "agent-app-view"
        ? `读取应用 · ${String(result.application)}`
        : result.type === "agent-app-action"
          ? `动作规范 · ${String(result.title)}`
          : result.status === "unknown"
            ? "页面结果未确认"
            : result.status === "cancelled"
              ? "页面动作已取消"
              : result.type === "platform-ui-view"
                ? `读取当前页面 · ${String(result.page)}`
                : result.status === "succeeded"
                  ? "页面操作已完成"
                  : result.status === "failed"
                    ? "页面动作未完成"
                    : "等待页面回执";
    return (
      <div className="assistant-action-result">
        <strong>
          {failed ? <WarningOutlined /> : <ControlOutlined />} {title}
        </strong>
        {!!details?.message && <p>{String(details.message)}</p>}
        {changes.length > 0 && (
          <details>
            <summary>已核对 {changes.length} 项字段变化 · 未保存</summary>
            {changes.map((change) => (
              <div key={change.target}>
                <strong>{change.label}</strong>
                <div className="page-change-values">
                  <del>{change.before || "空"}</del>
                  <span>→</span>
                  <ins>{change.after || "空"}</ins>
                </div>
                {change.truncated && <small>长文本仅显示摘要，请在页面核对完整内容。</small>}
              </div>
            ))}
          </details>
        )}
        <details>
          <summary>查看技术详情</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      </div>
    );
  }

  if (props.toolName === "platform_navigate" && typeof result.page === "string")
    return (
      <div className="assistant-tool-result">
        <ArrowRightOutlined />
        <span>前往对应功能继续操作</span>
        <Button
          onClick={() =>
            navigate(
              String(result.page),
              typeof result.resourceId === "string" ? result.resourceId : undefined,
            )
          }
        >
          打开页面
        </Button>
      </div>
    );
  if (props.toolName === "platform_propose")
    return (
      <div className="assistant-tool-result">
        <CheckCircleOutlined />
        <span>变更已准备，请在任务清单中审阅后应用。</span>
      </div>
    );
  if (props.toolName === "platform_skill" && result.skill && typeof result.skill === "object") {
    const skill = result.skill as Record<string, unknown>;
    return (
      <details className="assistant-skill-result">
        <summary>
          <FileTextOutlined /> {String(skill.name ?? "平台指导")} · 内置 v1
        </summary>
        <p>{String(skill.instructions ?? "")}</p>
      </details>
    );
  }
  return <ToolCard {...props} />;
};
