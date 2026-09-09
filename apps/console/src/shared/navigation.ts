export const pages = [
  "overview",
  "agents",
  "skills",
  "chat",
  "knowledge",
  "workflows",
  "models",
  "tools",
  "mcp",
  "runs",
  "applications",
  "runtimes",
] as const;
export type Page = (typeof pages)[number];
export type ResourceSelection = { selectedId?: string; onSelect(id?: string): void };
export function projectPath(projectId: string, page: Page = "overview", id?: string) {
  return `/projects/${encodeURIComponent(projectId)}/${page}${id ? `/${encodeURIComponent(id)}` : ""}`;
}
/** Login return paths must stay inside this console, including when supplied by a shared URL. */
export function loginDestination(search: string) {
  const target = new URLSearchParams(search).get("returnTo");
  if (!target?.startsWith("/") || target.startsWith("//") || /[\\\r\n]/.test(target)) return "/";
  const url = new URL(target, "http://console.invalid");
  return url.origin === "http://console.invalid" && url.pathname !== "/login" ? target : "/";
}
