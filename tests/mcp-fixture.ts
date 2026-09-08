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
              description: "合成写入能力，仅用于确认平台不会自动导入。",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: false },
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
      if (request.params.name !== "orders_lookup")
        throw new Error("Writes are disabled in the fixture");
      const data = {
        orderId: request.params.arguments?.orderId,
        status: state.invalidOutput ? 7 : "待发货",
        amount: 12800,
        sku: "GPU-A5000-24",
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
