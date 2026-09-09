import { createRoute } from "@hono/zod-openapi";
import { Project, ProjectInput, z } from "@platform/contracts";
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
}
