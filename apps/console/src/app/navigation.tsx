import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  BranchesOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  CodeOutlined,
  CommentOutlined,
  FileZipOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type React from "react";
import type { Page } from "../shared/navigation";

export type { Page } from "../shared/navigation";
export const navigation: [Page, string, React.ReactNode][] = [
  ["overview", "工作台", <AppstoreOutlined key="AppstoreOutlined" aria-hidden="true" />],
  ["agents", "Agents", <RobotOutlined key="RobotOutlined" aria-hidden="true" />],
  ["skills", "Skills", <FileZipOutlined key="skills" aria-hidden="true" />],
  ["chat", "对话", <CommentOutlined key="CommentOutlined" aria-hidden="true" />],
  ["knowledge", "知识库", <BookOutlined key="knowledge" aria-hidden="true" />],
  ["workflows", "工作流", <BranchesOutlined key="workflows" aria-hidden="true" />],
  ["models", "模型服务", <ApiOutlined key="ApiOutlined" aria-hidden="true" />],
  ["tools", "工具", <ToolOutlined key="ToolOutlined" aria-hidden="true" />],
  ["mcp", "MCP 服务", <ClusterOutlined key="mcp" aria-hidden="true" />],
  ["applications", "应用接入", <CodeOutlined key="CodeOutlined" aria-hidden="true" />],
  ["runtimes", "Runtime", <CloudServerOutlined key="CloudServerOutlined" aria-hidden="true" />],
  ["settings", "项目设置", <SettingOutlined key="SettingOutlined" aria-hidden="true" />],
];
export const pageTitles: Record<Page, [string, string]> = {
  settings: ["项目设置", "管理项目信息与成员，明确配置、发布与使用权限。"],
  team: ["团队设置", "管理团队账号、邀请和操作记录。"],
  overview: ["工作台", "从模型配置到业务调用，管理你的 Agent 项目。"],
  agents: ["Agents", "配置角色与工具，发布可供团队和业务系统使用的智能体。"],
  skills: ["Skills", "管理标准技能包，让 Agent 复用团队指令、资料与脚本。"],
  chat: ["对话", "与已发布的 Agent 协作，历史记录保存在当前项目。"],
  knowledge: ["知识库", "将团队资料转为可检索的知识，供 Agent 按需引用。"],
  workflows: ["工作流", "用自然语言编排业务流程，发布后按固定版本执行。"],
  models: ["模型服务", "登记团队使用的模型服务，并管理调用凭据。"],
  tools: ["工具", "让 Agent 使用经过登记的业务能力。"],
  mcp: ["MCP 服务", "连接业务服务，发现并审阅可供 Agent 使用的工具。"],
  runs: ["运行记录", "按会话查看全部轮次、模型响应与工具执行结果。"],
  applications: ["应用接入", "通过 OpenAPI 和生成 SDK，将 Agent 接入业务后端。"],
  runtimes: ["Runtime", "查看承接 Agent 执行的运行服务及连接状态。"],
};
