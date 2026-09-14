const errorNames: Record<string, string> = {
  TOKEN_BUDGET: "下一次请求将超出 Token 预算",
  MODEL_CALL_LIMIT: "已达到模型调用上限",
  STEP_LIMIT: "已达到执行步数上限",
  TOOL_OUTCOME_UNKNOWN: "上次工具结果待确认，已停止自动重试",
  WORKSPACE_LIMIT: "工作区达到容量限制",
  WORKSPACE_UNAVAILABLE: "工作区暂不可用",
  BUDGET_UNAVAILABLE: "预算服务暂不可用",
  TIMEOUT: "已达到时间预算",
  CANCELLED: "已取消",
  MODEL_ERROR: "模型执行异常",
};
export function formatRunError(message: string) {
  const code = message.replace(/^运行失败：\s*/, "");
  return errorNames[code] ?? message;
}
