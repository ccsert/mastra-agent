import { createRoute } from "@hono/zod-openapi";
import {
  Agent,
  AgentInput,
  AgentPreview,
  AgentPreviewInput,
  AgentUpdate,
  Release,
  z,
} from "@platform/contracts";
import {
  type ApiApp,
  body,
  errors,
  itemParams,
  json,
  projectParams,
} from "../../http/contracts.ts";
import type { Agents } from "./agents.ts";
export function registerAgentRoutes(app: ApiApp, agents: Agents) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/agents/{id}/preview",
      operationId: "previewAgent",
      request: { params: itemParams, body: body(AgentPreviewInput) },
      responses: { 200: json(AgentPreview), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param"),
        input = c.req.valid("json");
      return c.json(
        await agents.preview(
          c.get("principal"),
          projectId,
          id,
          input.baseRevision,
          input.requestId,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/agents",
      operationId: "listAgents",
      request: { params: projectParams },
      responses: { 200: json(z.array(Agent)), ...errors },
    }),
    async (c) => c.json(await agents.list(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/agents",
      operationId: "createAgent",
      request: { params: projectParams, body: body(AgentInput) },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) =>
      c.json(
        await agents.create(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/projects/{projectId}/agents/{id}",
      operationId: "updateAgent",
      request: { params: itemParams, body: body(AgentUpdate) },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param"),
        { baseRevision, ...input } = c.req.valid("json");
      return c.json(
        await agents.update(c.get("principal"), projectId, id, input, baseRevision),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/agents/{id}/publish",
      operationId: "publishAgent",
      request: {
        params: itemParams,
        body: body(z.object({ baseRevision: z.number().int().positive() }).strict()),
      },
      responses: { 200: json(Release), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await agents.publish(c.get("principal"), projectId, id, c.req.valid("json").baseRevision),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/agents/{id}/releases",
      operationId: "listReleases",
      request: { params: itemParams },
      responses: { 200: json(z.array(Release)), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await agents.releases(c.get("principal"), projectId, id), 200);
    },
  );
}
