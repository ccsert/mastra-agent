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
