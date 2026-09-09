import {
  ApiOutlined,
  AppstoreOutlined,
  BookOutlined,
  BranchesOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CommentOutlined,
  DeploymentUnitOutlined,
  FileZipOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type React from "react";
export type Page =
  | "overview"
  | "agents"
  | "skills"
  | "chat"
  | "knowledge"
  | "workflows"
  | "models"
  | "tools"
  | "mcp"
  | "runs"
  | "applications"
  | "runtimes";
export const navigation: [Page, string, React.ReactNode][] = [
  ["overview", "工作台", <AppstoreOutlined key="AppstoreOutlined" />],
  ["agents", "Agents", <RobotOutlined key="RobotOutlined" />],
  ["skills", "Skills", <FileZipOutlined key="skills" />],
  ["chat", "对话", <CommentOutlined key="CommentOutlined" />],
  ["knowledge", "知识库", <BookOutlined key="knowledge" />],
  ["workflows", "工作流", <BranchesOutlined key="workflows" />],
  ["models", "模型服务", <ApiOutlined key="ApiOutlined" />],
  ["tools", "工具", <ToolOutlined key="ToolOutlined" />],
  ["mcp", "MCP 服务", <ApiOutlined key="mcp" />],
  ["runs", "运行记录", <DeploymentUnitOutlined key="DeploymentUnitOutlined" />],
  ["applications", "应用接入", <CodeOutlined key="CodeOutlined" />],
  ["runtimes", "Runtime", <CloudServerOutlined key="CloudServerOutlined" />],
];
export const pageTitles: Record<Page, [string, string]> = {
  overview: ["工作台", "从模型配置到业务调用，管理你的 Agent 项目。"],
  agents: ["Agents", "配置角色与工具，发布可供团队和业务系统使用的智能体。"],
  skills: ["Skills", "管理标准技能包，让 Agent 复用团队指令、资料与脚本。"],
  chat: ["对话", "与已发布的 Agent 协作，历史记录保存在当前项目。"],
  knowledge: ["知识库", "将团队资料转为可检索的知识，供 Agent 按需引用。"],
  workflows: ["工作流", "用自然语言编排业务流程，发布后按固定版本执行。"],
  models: ["模型服务", "登记团队使用的模型服务，并管理调用凭据。"],
  tools: ["工具", "让 Agent 使用经过登记的业务能力。"],
  mcp: ["MCP 服务", "连接业务服务，发现并审阅可供 Agent 使用的工具。"],
  runs: ["运行记录", "查看任务状态、发布版本与工具执行结果。"],
  applications: ["应用接入", "通过 OpenAPI 和生成 SDK，将 Agent 接入业务后端。"],
  runtimes: ["Runtime", "查看承接 Agent 执行的运行服务及连接状态。"],
};
