import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  Id,
  McpDiscovery,
  McpFinish,
  McpImport,
  McpServer,
  McpServerInput,
  McpServerUpdate,
  type Principal,
  Tool,
  z,
} from "@platform/contracts";
import { body, errors, json } from "./http.ts";
import type { Mcp } from "./mcp.ts";

const project = z.object({ projectId: Id }),
  item = project.extend({ id: Id });
const root = "/api/v1/projects/{projectId}/mcp-servers";
export function registerMcpRoutes(
  app: OpenAPIHono<{ Variables: { principal: Principal } }>,
  mcp: Mcp,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: root,
      operationId: "listMcpServers",
      request: { params: project },
      responses: { 200: json(z.array(McpServer)), ...errors },
    }),
    async (c) => c.json(await mcp.list(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: root,
      operationId: "createMcpServer",
      request: { params: project, body: body(McpServerInput) },
      responses: { 200: json(McpServer), ...errors },
    }),
    async (c) =>
      c.json(
        await mcp.create(c.get("principal"), c.req.valid("param").projectId, c.req.valid("json")),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: `${root}/{id}`,
      operationId: "updateMcpServer",
      request: { params: item, body: body(McpServerUpdate) },
      responses: { 200: json(McpServer), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await mcp.update(c.get("principal"), p.projectId, p.id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}/discoveries`,
      operationId: "listMcpDiscoveries",
      request: { params: item },
      responses: { 200: json(z.array(McpDiscovery)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await mcp.discoveries(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/discoveries`,
      operationId: "discoverMcpTools",
      request: { params: item, body: body(z.object({}).strict()) },
      responses: { 200: json(McpDiscovery), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await mcp.discover(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/tools`,
      operationId: "importMcpTool",
      request: { params: item, body: body(McpImport) },
      responses: { 200: json(Tool), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await mcp.importTool(c.get("principal"), p.projectId, p.id, c.req.valid("json")),
        200,
      );
    },
  );
  app.post("/internal/runtime/mcp/claim", async (c) => c.json({ job: await mcp.claim() }));
  app.post("/internal/runtime/mcp/:id/heartbeat", async (c) => {
    const input = z
      .object({ leaseToken: z.string() })
      .strict()
      .parse(await c.req.json());
    await mcp.renew(Id.parse(c.req.param("id")), input.leaseToken);
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/mcp/:id/finish", async (c) => {
    await mcp.finish(Id.parse(c.req.param("id")), McpFinish.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/runs/:id/mcp", async (c) => {
    const input = z
      .object({ leaseToken: z.string(), toolId: Id })
      .strict()
      .parse(await c.req.json());
    return c.json(await mcp.authorize(Id.parse(c.req.param("id")), input.leaseToken, input.toolId));
  });
}
