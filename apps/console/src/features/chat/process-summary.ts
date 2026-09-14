import { asRecord } from "../../shared/ai/tool-content";

/** Preview only: the original content remains available in the disclosure. */
export function processPreview(text: string, latest = false): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const line = (latest ? lines.at(-1) : lines[0]) ?? "";
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .trim()
    .slice(0, 240);
}
const scalar = (value: unknown): string =>
  ["string", "number", "boolean"].includes(typeof value) ? processPreview(String(value)) : "";

export function toolSummary(toolName: string, input: unknown, output: unknown) {
  const args = asRecord(input),
    result = asRecord(output);
  const labels: Record<string, string> = {
    platform_ui: "操作当前页面",
    platform_catalog: "发现平台能力",
    platform_read: "读取平台资源",
    platform_skill: "加载平台指导",
    platform_propose: "准备资源变更",
    platform_navigate: "定位系统页面",
    task_read_history: "查阅任务历史",
    task_progress: "保存任务进度",
    task_read_progress: "读取任务进度",
    workspace_checkpoint: "版本检查点",
    workspace_publish: "保存产物",
    mastra_workspace_file_stat: "查看文件属性",
    mastra_workspace_mkdir: "创建目录",
    mastra_workspace_grep: "搜索文件内容",
    browser_evaluate: "页面交互与检查",
    browser_press_key: "键盘操作",
    browser_press: "键盘操作",
    mastra_workspace_read_file: "读取文件",
    mastra_workspace_write_file: "写入文件",
    mastra_workspace_edit_file: "修改文件",
    mastra_workspace_list_files: "浏览目录",
    mastra_workspace_execute_command: "运行命令",
    browser_goto: "打开网页",
    browser_snapshot: "读取页面",
    browser_screenshot: "截取页面",
    browser_check: "检查页面",
    browser_click: "点击元素",
    browser_fill: "填写内容",
    browser_scroll: "滚动页面",
    knowledge_search: "检索知识",
    skill: "加载 Skill",
    skill_read: "读取文件",
    skill_search: "检索 Skill",
    run_skill_script: "执行脚本",
    sum_values: "计算",
    update_plan: "更新计划",
  };
  const subject = [
    args.operation,
    args.entrypoint,
    args.command,
    args.url,
    args.path,
    args.query,
    args.title,
    args.name,
    args.skillName,
    args.skill,
  ]
    .map(scalar)
    .find(Boolean);
  const fallback = Object.entries(args)
    .filter(([, value]) => scalar(value))
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${scalar(value)}`)
    .join(" · ");
  const values = args.values;
  const calculation =
    toolName === "sum_values" && Array.isArray(values) && values.every((v) => typeof v === "number")
      ? values.slice(0, 8).join(" + ") + (values.length > 8 ? " + …" : "")
      : "";
  const outcome =
    toolName === "run_skill_script" && typeof result.exitCode === "number"
      ? `退出码 ${result.exitCode}`
      : toolName === "sum_values" && typeof result.total === "number"
        ? `→ ${result.total}`
        : toolName === "knowledge_search" && Array.isArray(result.sources)
          ? `${result.sources.length} 个来源`
          : Array.isArray(output)
            ? `${output.length} 条结果`
            : "";
  return {
    label: labels[toolName] ?? toolName,
    summary: (["skill_read", "run_skill_script"].includes(toolName) &&
    typeof args.skillName === "string"
      ? `${args.skillName} / ${subject || fallback}`
      : calculation || subject || fallback
    ).slice(0, 240),
    outcome,
  };
}
