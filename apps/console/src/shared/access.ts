import type { Permission, ProjectAccess } from "@platform/sdk";
import { createContext, useContext } from "react";
import type { Page } from "./navigation";

export const ProjectAccessContext = createContext<ProjectAccess | undefined>(undefined);
export const useProjectAccess = () => useContext(ProjectAccessContext);
export const roleNames = {
  owner: "团队所有者",
  admin: "管理员",
  editor: "编辑者",
  member: "使用者",
  viewer: "只读成员",
};
export const projectRoleOptions = [
  { value: "admin", label: "管理员 · 成员、配置与发布" },
  { value: "editor", label: "编辑者 · 配置与草稿试用" },
  { value: "member", label: "使用者 · 使用已发布 Agent" },
  { value: "viewer", label: "只读成员 · 查看配置" },
];
export function pagePermission(page: Page): Permission {
  if (["settings"].includes(page)) return "project.manage";
  if (["models", "mcp", "applications"].includes(page)) return "resource.manage";
  if (["knowledge", "skills", "tools"].includes(page)) return "resource.read";
  if (["workflows"].includes(page)) return "resource.edit";
  if (page === "chat") return "agent.run";
  return "project.read";
}
