import { createRoute } from "@hono/zod-openapi";
import { Project, ProjectInput, ProjectPatch, z } from "@platform/contracts";
import { type ApiApp, body, errors, json } from "../../http/contracts.ts";
import type { Projects } from "./projects.ts";
export function registerProjectRoutes(app: ApiApp, projects: Projects) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects",
      operationId: "listProjects",
      responses: { 200: json(z.array(Project)), ...errors },
    }),
    async (c) => c.json(await projects.list(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects",
      operationId: "createProject",
      request: { body: body(ProjectInput) },
      responses: { 200: json(Project), ...errors },
    }),
    async (c) => c.json(await projects.create(c.get("principal"), c.req.valid("json")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}",
      operationId: "getProject",
      request: { params: z.object({ projectId: z.string().uuid() }) },
      responses: { 200: json(Project), ...errors },
    }),
    async (c) =>
      c.json(await projects.get(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/projects/{projectId}",
      operationId: "updateProject",
      request: {
        body: body(ProjectPatch),
        params: z.object({ projectId: z.string().uuid() }),
      },
      responses: { 200: json(Project), ...errors },
    }),
    async (c) =>
      c.json(
        await projects.update(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  for (const [method, path, operationId, archived] of [
    ["post", "/api/v1/projects/{projectId}/archive", "archiveProject", true],
    ["post", "/api/v1/projects/{projectId}/unarchive", "unarchiveProject", false],
  ] as const) {
    app.openapi(
      createRoute({
        method,
        path,
        operationId,
        request: {
          body: body(z.object({}).strict()),
          params: z.object({ projectId: z.string().uuid() }),
        },
        responses: { 200: json(Project), ...errors },
      }),
      async (c) =>
        c.json(
          await projects.setArchived(c.get("principal"), c.req.valid("param").projectId, archived),
          200,
        ),
    );
  }
}
