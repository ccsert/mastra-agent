import { createRoute } from "@hono/zod-openapi";
import { Model, ModelInput, Project, ProjectInput, Tool, ToolInput, z } from "@platform/contracts";
import { type ApiApp, body, errors, json, projectParams } from "./http.ts";
import type { Projects } from "./projects.ts";
import type { Resources } from "./resources.ts";
export function registerResourceRoutes(app: ApiApp, projects: Projects, resources: Resources) {
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
      path: "/api/v1/projects/{projectId}/models",
      operationId: "listModels",
      request: { params: projectParams },
      responses: { 200: json(z.array(Model)), ...errors },
    }),
    async (c) =>
      c.json(await resources.models(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/models",
      operationId: "createModel",
      request: { params: projectParams, body: body(ModelInput) },
      responses: { 200: json(Model), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await resources.createModel(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/tools",
      operationId: "listTools",
      request: { params: projectParams },
      responses: { 200: json(z.array(Tool)), ...errors },
    }),
    async (c) =>
      c.json(await resources.tools(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/tools",
      operationId: "createTool",
      request: { params: projectParams, body: body(ToolInput) },
      responses: { 200: json(Tool), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await resources.createTool(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
}
