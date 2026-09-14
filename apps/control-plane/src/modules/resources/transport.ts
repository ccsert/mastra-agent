import { z } from "@platform/contracts";
/** Long enough for a cold service, short enough that the console stays responsive. */
export const REQUEST_TIMEOUT_MS = 15000;
/**
 * The timeout the Runtime itself applies when a model calls a tool. A probe that
 * allowed longer would report "ok" for a call that times out during a real run.
 */
export const TOOL_TIMEOUT_MS = 10000;
/** A probe is not a completion: it never reads more than this. */
const MAX_BYTES = 65536;
const messageBody = z.object({ message: z.string() }),
  errorBody = z.object({ error: z.unknown() });
/** Reports the provider's own words when it gave any, bounded and whitespace-collapsed. */
export function detail(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "服务未返回正文。";
  try {
    const raw = JSON.parse(compact),
      direct = messageBody.safeParse(raw);
    if (direct.success) return direct.data.message.slice(0, 300);
    const nested = errorBody.safeParse(raw);
    if (nested.success) {
      const inner = messageBody.safeParse(nested.data.error);
      if (inner.success) return inner.data.message.slice(0, 300);
    }
  } catch {
    // Not JSON; the raw prefix is still the provider's own words.
  }
  return compact.slice(0, 300);
}
export async function readBounded(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const buffers: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    buffers.push(value);
  }
  return Buffer.concat(buffers).toString("utf8");
}
export function transportMessage(error: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (error instanceof Error && error.name === "TimeoutError")
    return `平台在 ${timeoutMs / 1000} 秒内没有得到响应。`;
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" ? `平台无法连接该地址（${code}）。` : "平台无法连接该地址。";
}
/** Sends one bounded request the way the Runtime would, with the platform's own timeout. */
export async function requestBounded(
  url: string,
  key: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number },
): Promise<{ response: Response; latencyMs: number }> {
  const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS,
    startedAt = Date.now(),
    response = await fetch(url, {
      method: init.method,
      redirect: "error",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  return { response, latencyMs: Date.now() - startedAt };
}
