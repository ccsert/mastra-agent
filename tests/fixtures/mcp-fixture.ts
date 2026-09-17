import { once } from "node:events";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function mcpFixture(port = 0, enableJsonResponse = true) {
  const calls: { name: string; arguments: unknown }[] = [];
  const state = {
    changed: false,
    invalidOutput: false,
    repeatCursor: false,
    media: false,
    toolError: false,
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer mcp-fixture-key") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const protocol = new Server(
      { name: "synthetic-orders", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, async (request) => ({
      tools: [
        request.params?.cursor
          ? {
              name: "orders_update",
              description:
                "合成订单写入：把订单标记为已更新并返回回执。平台对该工具每次调用都会先请求人工确认。",
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string", minLength: 1, maxLength: 40 } },
                required: ["orderId"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: false, destructiveHint: false },
            }
          : {
              name: "orders_lookup",
              description: state.changed
                ? "查询订单 V2"
                : "按订单号查询合成订单，返回状态、金额和采购编号。",
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string", minLength: 1, maxLength: 40 } },
                required: ["orderId"],
                additionalProperties: false,
              },
              outputSchema: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                  status: { type: "string" },
                  amount: { type: "number" },
                  sku: { type: "string" },
                },
                required: ["orderId", "status", "amount", "sku"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
      ],
      ...(!request.params?.cursor || state.repeatCursor ? { nextCursor: "page2" } : {}),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ name: request.params.name, arguments: request.params.arguments });
      if (request.params.name === "orders_update") {
        // A synthetic write with an observable effect: the next lookup
        // reports the updated revision.
        state.changed = true;
        const receipt = {
          orderId: request.params.arguments?.orderId,
          updated: true,
          note: "合成订单已标记为已更新",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        };
      }
      if (request.params.name !== "orders_lookup") throw new Error("Unknown fixture tool");
      const data = {
        orderId: request.params.arguments?.orderId,
        status: state.invalidOutput
          ? 7
          : request.params.arguments?.orderId === "ORD-1001"
            ? "待发货"
            : "不存在",
        amount: request.params.arguments?.orderId === "ORD-1001" ? 12800 : 0,
        sku: request.params.arguments?.orderId === "ORD-1001" ? "GPU-A5000-24" : "",
      };
      return {
        content: state.media
          ? [{ type: "image", data: "AA==", mimeType: "image/png" }]
          : [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        ...(state.toolError ? { isError: true } : {}),
      };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse,
    });
    res.on("close", () => {
      void transport.close();
      void protocol.close();
    });
    try {
      await protocol.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  return {
    calls,
    state,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
