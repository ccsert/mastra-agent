import { createRoute } from "@hono/zod-openapi";
import {
  Id,
  PageQuery,
  SkillAccessRequest,
  SkillFileContent,
  SkillPath,
  SkillUpload,
  SkillVersion,
  z,
} from "@platform/contracts";
import { type ApiApp, body, errors, itemParams, json, pageJson, projectParams } from "./http.ts";
import type { Skills } from "./skills.ts";
export function registerSkillRoutes(app: ApiApp, skills: Skills) {
  const root = "/api/v1/projects/{projectId}/skills";
  app.openapi(
    createRoute({
      method: "get",
      path: root,
      operationId: "listSkills",
      request: { params: projectParams, query: PageQuery },
      responses: { 200: pageJson(SkillVersion), ...errors },
    }),
    async (c) => {
      const page = await skills.list(
        c.get("principal"),
        c.req.valid("param").projectId,
        c.req.valid("query"),
      );
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      return c.json(page.items, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: root,
      operationId: "uploadSkill",
      request: { params: projectParams, body: body(SkillUpload) },
      responses: { 200: json(SkillVersion), ...errors },
    }),
    async (c) =>
      c.json(
        await skills.upload(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json").archiveBase64,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}`,
      operationId: "getSkill",
      request: { params: itemParams },
      responses: { 200: json(SkillVersion), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await skills.get(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: `${root}/{id}/access`,
      operationId: "setSkillAccess",
      request: { params: itemParams, body: body(z.object({ enabled: z.boolean() }).strict()) },
      responses: { 200: json(SkillVersion), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await skills.setEnabled(c.get("principal"), projectId, id, c.req.valid("json").enabled),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}/file`,
      operationId: "getSkillFile",
      request: { params: itemParams, query: z.object({ path: SkillPath }) },
      responses: { 200: json(SkillFileContent), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await skills.file(c.get("principal"), projectId, id, c.req.valid("query").path),
        200,
      );
    },
  );
}
export function registerSkillRuntimeRoutes(app: ApiApp, skills: Skills) {
  app.post("/internal/runtime/runs/:id/skills", async (c) =>
    c.json(
      await skills.runAccess(
        Id.parse(c.req.param("id")),
        SkillAccessRequest.parse(await c.req.json()),
      ),
    ),
  );
}
