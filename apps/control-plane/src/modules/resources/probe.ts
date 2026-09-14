import { ModelProbe, type ModelProbeInput, z } from "@platform/contracts";
import { detail, readBounded, requestBounded, transportMessage } from "./transport.ts";

/**
 * The same paths the Runtime itself calls, so a probe verifies the request the
 * platform will actually make instead of a different one that merely succeeds.
 */
const paths = { chat: "/chat/completions", embedding: "/embeddings", rerank: "/rerank" } as const;

const probeBody = (input: ModelProbeInput) => {
  if (input.kind === "chat")
    return {
      model: input.modelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    };
  if (input.kind === "embedding")
    return {
      model: input.modelId,
      input: ["ping"],
      encoding_format: "float",
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    };
  return { model: input.modelId, query: "ping", documents: ["ping"], top_n: 1 };
};

type Verified =
  | { ok: true; dimensions: number | null; message: string }
  | { ok: false; message: string };

/** Checks the response shape the Runtime requires, not merely a 200. */
function verify(kind: ModelProbeInput["kind"], raw: unknown, configured?: number): Verified {
  if (kind === "chat")
    return z.object({ choices: z.array(z.unknown()).min(1) }).safeParse(raw).success
      ? { ok: true, dimensions: null, message: "服务返回了对话补全响应。" }
      : { ok: false, message: "服务返回 200，但不是对话补全格式（缺少 choices）。" };
  if (kind === "embedding") {
    const parsed = z
      .object({ data: z.array(z.object({ embedding: z.array(z.number()) })).min(1) })
      .safeParse(raw);
    if (!parsed.success)
      return { ok: false, message: "服务返回 200，但不是向量格式（缺少 data[].embedding）。" };
    const found = parsed.data.data[0]?.embedding.length ?? 0;
    if (configured !== undefined && found !== configured)
      return { ok: false, message: `服务返回 ${found} 维，与配置的 ${configured} 维不一致。` };
    return { ok: true, dimensions: found, message: `服务返回 ${found} 维向量。` };
  }
  return z
    .object({
      results: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })).min(1),
    })
    .safeParse(raw).success
    ? { ok: true, dimensions: null, message: "服务返回了重排结果。" }
    : { ok: false, message: "服务返回 200，但不是重排格式（缺少 results）。" };
}

/**
 * Probes one model service from the control plane the way the Runtime would.
 * A reachable-but-wrong configuration and an unreachable address are reported as
 * different outcomes, so "平台连不上" is never presented as "模型配错了".
 */
export async function probeModelRequest(input: ModelProbeInput, key: string): Promise<ModelProbe> {
  const url = `${input.baseUrl.replace(/\/$/, "")}${paths[input.kind]}`,
    startedAt = Date.now();
  let response: Response, latencyMs: number;
  try {
    ({ response, latencyMs } = await requestBounded(url, key, {
      method: "POST",
      body: probeBody(input),
    }));
  } catch (error) {
    return ModelProbe.parse({
      outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
      httpStatus: null,
      // How long the attempt took before failing is still a real measurement.
      latencyMs: Date.now() - startedAt,
      message: transportMessage(error),
      dimensions: null,
    });
  }
  let text: string;
  try {
    text = await readBounded(response);
  } catch {
    return ModelProbe.parse({
      outcome: "unreachable",
      httpStatus: response.status,
      latencyMs,
      message: "读取响应时连接中断。",
      dimensions: null,
    });
  }
  if (!response.ok)
    return ModelProbe.parse({
      outcome: "rejected",
      httpStatus: response.status,
      latencyMs,
      message: `服务返回 ${response.status}：${detail(text)}`,
      dimensions: null,
    });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ModelProbe.parse({
      outcome: "rejected",
      httpStatus: response.status,
      latencyMs,
      message: "服务返回 200，但响应不是 JSON。",
      dimensions: null,
    });
  }
  const verified = verify(input.kind, raw, input.dimensions);
  return ModelProbe.parse({
    outcome: verified.ok ? "ok" : "rejected",
    httpStatus: response.status,
    latencyMs,
    message: verified.message,
    dimensions: verified.ok ? verified.dimensions : null,
  });
}
