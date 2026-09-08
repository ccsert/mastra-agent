import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  canonicalJson,
  compileMcpSchema,
  McpDescriptor,
  McpErrorCode,
  type z,
} from "@platform/contracts";

type Binding = { url: string; bearerToken: string };
type Descriptor = z.infer<typeof McpDescriptor>;
const known = new Set<string>([...McpErrorCode.options, "MCP_DISCOVERY_INVALID"]);

async function withClient<T>(
  binding: Binding,
  signal: AbortSignal,
  action: (client: Client) => Promise<T>,
) {
  const endpoint = new URL(binding.url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("MCP_CONNECTION_FAILED");
  const active = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  let total = 0,
    requests = 0;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: binding.bearerToken ? { authorization: `Bearer ${binding.bearerToken}` } : {},
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (new URL(url).href !== endpoint.href || ++requests > 32) throw new Error("MCP_LIMIT");
      const response = await fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([active, ...(init?.signal ? [init.signal] : [])]),
      });
      if (!response.body) return response;
      let size = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            total += chunk.byteLength;
            if (size > 262144 || total > 1048576) throw new Error("MCP_LIMIT");
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const client = new Client(
    { name: "agent-platform", version: "0.1.0" },
    {
      capabilities: {},
      jsonSchemaValidator: {
        getValidator: <T>(schema: Record<string, unknown>) => {
          // Discovery may contain capabilities outside our import profile. Compile only
          // when validating a call, so unrelated unreviewed schemas never execute here.
          return (value: unknown) => {
            try {
              if (compileMcpSchema(schema)(value))
                return { valid: true as const, data: value as T, errorMessage: undefined };
            } catch {
              /* Unsupported schemas cannot validate a result. */
            }
            return { valid: false as const, data: undefined, errorMessage: "MCP_RESULT_INVALID" };
          };
        },
      },
    },
  );
  try {
    await client.connect(transport, { signal: active, timeout: 10000 });
    return await action(client);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof Error && known.has(error.message)) throw error;
    if (active.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout))
      throw new Error("MCP_TIMEOUT");
    throw new Error("MCP_CONNECTION_FAILED");
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

async function list(client: Client, signal: AbortSignal): Promise<Descriptor[]> {
  const tools: Descriptor[] = [],
    names = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10000 });
    for (const raw of result.tools) {
      const parsed = McpDescriptor.safeParse(raw);
      if (!parsed.success || names.has(raw.name)) throw new Error("MCP_DISCOVERY_INVALID");
      names.add(raw.name);
      tools.push(parsed.data);
    }
    if (tools.length > 100 || JSON.stringify(tools).length > 200000) throw new Error("MCP_LIMIT");
    if (result.nextCursor === undefined) return tools.sort((a, b) => a.name.localeCompare(b.name));
    if (!result.nextCursor || cursors.has(result.nextCursor))
      throw new Error("MCP_DISCOVERY_INVALID");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("MCP_LIMIT");
}

export async function discoverMcp(binding: Binding, signal: AbortSignal) {
  return withClient(binding, signal, (client) => list(client, signal));
}

export async function callMcpTool(
  binding: Binding,
  descriptor: Descriptor,
  input: unknown,
  signal: AbortSignal,
  authorize?: () => Promise<void>,
) {
  if (!compileMcpSchema(descriptor.inputSchema)(input)) throw new Error("MCP_INPUT_INVALID");
  if (descriptor.execution?.taskSupport === "required") throw new Error("MCP_SCHEMA_UNSUPPORTED");
  return withClient(binding, signal, async (client) => {
    const current = (await list(client, signal)).find((d) => d.name === descriptor.name);
    if (!current || canonicalJson(current) !== canonicalJson(descriptor))
      throw new Error("MCP_CONTRACT_CHANGED");
    await authorize?.();
    signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = await client.callTool(
        { name: descriptor.name, arguments: input as Record<string, unknown> },
        CallToolResultSchema,
        { signal, timeout: 15000 },
      );
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
        throw new Error("MCP_TIMEOUT");
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams)
        throw new Error("MCP_RESULT_INVALID");
      throw error;
    }
    const result = CallToolResultSchema.parse(raw);
    if (result.isError) throw new Error("MCP_TOOL_ERROR");
    if (result.content.some((c) => c.type !== "text")) throw new Error("MCP_CONTENT_UNSUPPORTED");
    if (
      descriptor.outputSchema &&
      !compileMcpSchema(descriptor.outputSchema)(result.structuredContent)
    )
      throw new Error("MCP_RESULT_INVALID");
    const output = {
      text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
      ...(result.structuredContent ? { data: result.structuredContent } : {}),
    };
    if (JSON.stringify(output).length > 32000) throw new Error("MCP_LIMIT");
    await authorize?.();
    return output;
  });
}
