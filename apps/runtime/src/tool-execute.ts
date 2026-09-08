import { compileMcpSchema, type Tool, type z } from "@platform/contracts";
import Ajv from "ajv";
import { callMcpTool } from "./mcp.ts";

export async function executePlatformTool(
  definition: z.infer<typeof Tool>,
  input: unknown,
  signal: AbortSignal,
  token: string,
  authorizeMcp?: () => Promise<{ url: string; bearerToken: string }>,
) {
  signal.throwIfAborted();
  const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
  const validateInput =
    definition.kind === "mcp"
      ? compileMcpSchema(definition.inputSchema)
      : ajv.compile(definition.inputSchema);
  if (!validateInput(input)) throw new Error("TOOL_INPUT_INVALID");
  let output: unknown;
  if (definition.kind === "sum")
    output = { total: (input as { values: number[] }).values.reduce((a, b) => a + b, 0) };
  else if (definition.kind === "mcp") {
    if (!definition.mcp || !authorizeMcp) throw new Error("MCP_AUTH_DENIED");
    const binding = await authorizeMcp();
    output = await callMcpTool(binding, definition.mcp.descriptor, input, signal, async () => {
      const current = await authorizeMcp();
      if (current.url !== binding.url || current.bearerToken !== binding.bearerToken)
        throw new Error("MCP_AUTH_DENIED");
    });
  } else {
    const url = new URL(definition.url);
    for (const [key, value] of Object.entries(input as Record<string, unknown>))
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error("TOOL_HTTP_ERROR");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("TOOL_EMPTY_RESPONSE");
    let bytes = 0,
      body = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error("TOOL_RESULT_TOO_LARGE");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    output = JSON.parse(body);
  }
  if (!ajv.compile(definition.outputSchema)(output)) throw new Error("TOOL_OUTPUT_INVALID");
  signal.throwIfAborted();
  return output;
}
