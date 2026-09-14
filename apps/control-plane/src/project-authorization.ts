import { Id, type Permission, type Principal } from "@platform/contracts";
import type { Access } from "./modules/access/index.ts";

/** New project routes require an explicit policy; unclassified operations require resource management. */
export async function authorizeProjectRequest(
  access: Access,
  actor: Principal,
  path: string,
  method: string,
) {
  const parts = decodeURIComponent(path).split("/");
  if (parts[1] !== "api" || parts[2] !== "v1" || parts[3] !== "projects" || !parts[4]) return;
  const projectId = Id.parse(parts[4]),
    resource = parts[5],
    read = method === "GET" || method === "HEAD";
  let permission: Permission = "resource.manage";
  switch (resource) {
    case "assistant":
      permission = "project.read";
      break;
    case "access":
      permission = "project.read";
      break;
    case "members":
    case "invitations":
    case "audit":
      permission = "project.manage";
      break;
    case "agents":
      permission = read
        ? parts[7] === "releases"
          ? "resource.read"
          : "project.read"
        : parts[7] === "publish"
          ? "agent.publish"
          : "agent.edit";
      break;
    case "conversations":
    case "runs":
      permission = read ? "project.read" : "agent.run";
      break;
    case "models":
    case "tools":
    case "mcp-servers":
      permission = read ? "resource.read" : "resource.manage";
      break;
    case "skills":
      permission = read
        ? "resource.read"
        : parts[7] === "access"
          ? "resource.manage"
          : "resource.edit";
      break;
    case "knowledge":
      permission = read ? "resource.read" : "resource.edit";
      break;
    case "workflows":
      permission = read
        ? "resource.read"
        : parts[7] === "publish"
          ? "agent.publish"
          : parts[7] === "runs"
            ? "agent.run"
            : "agent.edit";
      break;
    case "workflow-runs":
      permission = read ? "project.read" : "agent.run";
      break;
    case "workflow-generations":
      permission = "agent.edit";
      break;
  }
  await access.require(actor, projectId, permission);
}
