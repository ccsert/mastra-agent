import { client } from "@platform/sdk";

client.setConfig({ baseUrl: window.location.origin, credentials: "include" });
/**
 * Turns a failed SDK result into a message that names the actual cause. The
 * client resolves HTTP failures as an `error` value instead of rejecting, and
 * `error` is **not** always an object: for a response whose body is not JSON
 * (a proxy's HTML error page, or Hono's plain-text `404 Not Found` for a route
 * that does not exist) the client throws the raw text, so the old
 * `"无法连接平台服务"` fallback described a network outage for what was really a
 * missing endpoint — the operator would go looking at the network instead of at
 * the deployment. The status is therefore read from `response` and every branch
 * states a cause the operator can act on.
 */
function failureMessage(error: unknown, response: Response | undefined): string {
  const code = response?.status;
  // No response at all means the request never got an answer, which is what a
  // stopped service actually looks like. This is checked before the message
  // below because a transport failure's `TypeError` also carries `.message`,
  // and surfacing that raw would read as "fetch failed" rather than a cause.
  if (code === undefined) return "无法连接平台服务，请确认服务已启动。";
  // The server's own message is the most specific thing available, so it wins
  // whenever the body parsed as the platform's `{ code, message }` shape.
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  // A route the platform does not serve. Hono answers with plain text, which the
  // client can only surface as an unhelpful string, so it is named explicitly:
  // the usual cause is a console newer than the running control plane.
  if (code === 404)
    return "平台没有这个接口（404）。后端可能还没更新到当前代码，请重启服务后重试。";
  if (code >= 500) return `平台服务出错（HTTP ${code}），请查看服务日志。`;
  return typeof error === "string" && error.trim() ? error : `请求失败（HTTP ${code}）`;
}
export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown; response?: Response }>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await request;
  signal?.throwIfAborted();
  if (result.error || result.data === undefined)
    throw new Error(failureMessage(result.error, result.response));
  return result.data;
}
export const timestamp = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export type Page<T> = { items: T[]; nextCursor: string | null };
export async function unwrapPage<T>(
  request: Promise<{ data?: T[]; error?: unknown; response?: Response }>,
): Promise<Page<T>> {
  const result = await request;
  const items = await unwrap(Promise.resolve(result));
  if (!result.response) throw new Error("分页响应缺少 HTTP 元数据，请重试");
  return { items, nextCursor: result.response.headers.get("X-Next-Cursor") };
}
