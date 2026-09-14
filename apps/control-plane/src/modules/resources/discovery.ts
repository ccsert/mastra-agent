import { type ModelDiscoverInput, ModelDiscovery, z } from "@platform/contracts";
import { detail, readBounded, requestBounded, transportMessage } from "./transport.ts";

/**
 * The catalogue endpoint the OpenAI protocol defines. Vendors that do not
 * implement it answer 404 or 405 instead, which is reported as `unsupported`
 * rather than as a failure — plenty of self-hosted deployments serve chat only.
 */
const CATALOGUE_PATH = "/models";
const catalogueBody = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).max(2000),
});

/**
 * Lists the model ids a service advertises, so an operator picks from what the
 * service actually offers instead of typing an id from memory. The response is
 * only a candidate list: it says nothing about capabilities, and a listed id is
 * not verified to work until it is probed.
 */
export async function discoverModelsRequest(
  input: ModelDiscoverInput,
  key: string,
): Promise<ModelDiscovery> {
  const url = `${input.baseUrl.replace(/\/$/, "")}${CATALOGUE_PATH}`,
    startedAt = Date.now();
  let response: Response, latencyMs: number;
  try {
    ({ response, latencyMs } = await requestBounded(url, key, { method: "GET" }));
  } catch (error) {
    return ModelDiscovery.parse({
      outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      message: transportMessage(error),
      models: [],
    });
  }
  let text: string;
  try {
    text = await readBounded(response);
  } catch {
    return ModelDiscovery.parse({
      outcome: "unreachable",
      httpStatus: response.status,
      latencyMs,
      message: "读取响应时连接中断。",
      models: [],
    });
  }
  if (!response.ok) {
    // A service without a catalogue endpoint answers 404/405; that is a
    // property of the deployment, not a rejected credential.
    const missing = response.status === 404 || response.status === 405;
    return ModelDiscovery.parse({
      outcome: missing ? "unsupported" : "rejected",
      httpStatus: response.status,
      latencyMs,
      message: missing
        ? "服务未提供模型列表接口，请手动填写模型 ID。"
        : `服务返回 ${response.status}：${detail(text)}`,
      models: [],
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ModelDiscovery.parse({
      outcome: "rejected",
      httpStatus: response.status,
      latencyMs,
      message: "服务返回 200，但响应不是 JSON。",
      models: [],
    });
  }
  const parsed = catalogueBody.safeParse(raw);
  if (!parsed.success)
    return ModelDiscovery.parse({
      outcome: "unsupported",
      httpStatus: response.status,
      latencyMs,
      message: "服务返回 200，但响应不是模型列表格式（缺少 data[].id）。",
      models: [],
    });
  // Deduplicated and sorted so the console shows a stable list across requests.
  const models = [...new Set(parsed.data.data.map((entry) => entry.id.trim()))]
    .filter((id) => id.length > 0 && id.length <= 200)
    .sort();
  return ModelDiscovery.parse({
    outcome: "ok",
    httpStatus: response.status,
    latencyMs,
    message: models.length
      ? `服务列出了 ${models.length} 个模型 ID。`
      : "服务未列出任何模型 ID，请手动填写。",
    models,
  });
}
