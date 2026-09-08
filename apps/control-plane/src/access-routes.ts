import { createRoute } from "@hono/zod-openapi";
import { Application, RuntimeInfo, z } from "@platform/contracts";
import type { Applications } from "./applications.ts";
import { type ApiApp, body, errors, itemParams, json, projectParams } from "./http.ts";
import type { Runtimes } from "./runtimes.ts";
export function registerAccessRoutes(app: ApiApp, applications: Applications, runtimes: Runtimes) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtimes",
      operationId: "listRuntimes",
      responses: { 200: json(z.array(RuntimeInfo)), ...errors },
    }),
    async (c) => c.json(await runtimes.list(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/applications",
      operationId: "listApplications",
      request: { params: projectParams },
      responses: { 200: json(z.array(Application)), ...errors },
    }),
    async (c) =>
      c.json(await applications.list(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/applications",
      operationId: "createApplication",
      request: {
        params: projectParams,
        body: body(z.object({ name: z.string().trim().min(1).max(80) }).strict()),
      },
      responses: { 200: json(Application.extend({ secretKey: z.string() })), ...errors },
    }),
    async (c) =>
      c.json(
        await applications.create(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json").name,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/applications/{id}/revoke",
      operationId: "revokeApplication",
      request: { params: itemParams, body: body(z.object({}).strict()) },
      responses: { 200: json(z.object({ ok: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      await applications.revoke(c.get("principal"), projectId, id);
      return c.json({ ok: true }, 200);
    },
  );
}
