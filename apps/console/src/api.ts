import { client } from "@platform/sdk";

client.setConfig({ baseUrl: window.location.origin, credentials: "include" });
export async function unwrap<T>(
  request: Promise<{ data?: T; error?: unknown }>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await request;
  signal?.throwIfAborted();
  if (result.error || result.data === undefined) {
    const error = result.error;
    throw new Error(
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "无法连接平台服务",
    );
  }
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
