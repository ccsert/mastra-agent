import { ToolProbe, type ToolProbeInput } from "@platform/contracts";
import { Ajv } from "ajv";
import {
  detail,
  readBounded,
  requestBounded,
  TOOL_TIMEOUT_MS,
  transportMessage,
} from "./transport.ts";

/**
 * Reproduces the call the Runtime makes when a model invokes the tool, so a
 * probe verifies the request that will actually be sent rather than one that
 * merely succeeds. `sum` is evaluated locally because that is exactly what the
 * Runtime does for it — no request is involved and none is invented.
 */
/** What a call produced: the output itself, plus whether it satisfies the declared schema. */
type Evaluated = { outcome: "ok" | "mismatch"; output: unknown };

const validator = () => new Ajv({ strict: false, allErrors: true, addUsedSchema: false });

/** A bounded, single-line rendering so an operator can compare shapes by eye. */
function preview(value: unknown) {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return "无法序列化返回内容。";
  }
  if (text === undefined) return "返回内容为空。";
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/**
 * Checks the output against the declared schema the same way the Runtime does.
 * `mismatch` is kept separate from a refusal: only a mismatch is fixed by
 * editing the schema, and reporting both as "failed" would send an operator
 * looking at the wrong thing.
 */
export async function probeToolRequest(input: ToolProbeInput, token: string): Promise<ToolProbe> {
  // A wrong sample is an operator error and must not be reported as a service
  // failure, so the input schema is checked before anything is sent.
  const ajv = validator(),
    validateInput = ajv.compile(input.inputSchema);
  if (!validateInput(input.input))
    return ToolProbe.parse({
      outcome: "invalid",
      httpStatus: null,
      latencyMs: null,
      message: `样例参数不符合输入 schema：${ajv.errorsText(validateInput.errors)}`.slice(0, 500),
      requestUrl: null,
      preview: null,
    });
  const validateOutput = validator().compile(input.outputSchema);
  const verify = (output: unknown): Evaluated =>
    validateOutput(output) ? { outcome: "ok", output } : { outcome: "mismatch", output };
  if (input.kind === "sum") {
    const values = (input.input as { values: number[] }).values,
      output = { total: values.reduce((a, b) => a + b, 0) },
      evaluated = verify(output);
    return ToolProbe.parse({
      outcome: evaluated.outcome,
      // Nothing left the platform, so there is no status or latency to report.
      httpStatus: null,
      latencyMs: null,
      message:
        evaluated.outcome === "ok"
          ? `求和结果为 ${output.total}。`
          : "求和结果不符合声明的输出 schema。",
      requestUrl: null,
      preview: preview(output),
    });
  }
  const url = new URL(input.url);
  for (const [key, value] of Object.entries(input.input as Record<string, unknown>))
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const startedAt = Date.now();
  let response: Response, latencyMs: number;
  try {
    ({ response, latencyMs } = await requestBounded(url.toString(), token, {
      method: "GET",
      timeoutMs: TOOL_TIMEOUT_MS,
    }));
  } catch (error) {
    return ToolProbe.parse({
      outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable",
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      message: transportMessage(error, TOOL_TIMEOUT_MS),
      requestUrl: url.toString(),
      preview: null,
    });
  }
  let text: string;
  try {
    text = await readBounded(response);
  } catch {
    return ToolProbe.parse({
      outcome: "unreachable",
      httpStatus: response.status,
      latencyMs,
      message: "读取响应时连接中断。",
      requestUrl: url.toString(),
      preview: null,
    });
  }
  if (!response.ok)
    return ToolProbe.parse({
      outcome: "rejected",
      httpStatus: response.status,
      latencyMs,
      message: `服务返回 ${response.status}：${detail(text)}`,
      requestUrl: url.toString(),
      preview: null,
    });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ToolProbe.parse({
      outcome: "rejected",
      httpStatus: response.status,
      latencyMs,
      message: "服务返回 200，但响应不是 JSON。",
      requestUrl: url.toString(),
      preview: null,
    });
  }
  const evaluated = verify(raw);
  return ToolProbe.parse({
    outcome: evaluated.outcome,
    httpStatus: response.status,
    latencyMs,
    message:
      evaluated.outcome === "ok"
        ? "返回内容符合声明的输出 schema。"
        : "服务返回了 JSON，但不符合声明的输出 schema。",
    requestUrl: url.toString(),
    preview: preview(evaluated.output),
  });
}
