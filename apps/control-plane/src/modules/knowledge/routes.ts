import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  DocumentInput,
  Id,
  KnowledgeBase,
  KnowledgeBatch,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeFinish,
  KnowledgeInput,
  KnowledgeSearch,
  PageQuery,
  type Principal,
  SearchInput,
  VectorQuery,
  z,
} from "@platform/contracts";
import { body, errors, json, pageJson } from "../../http/contracts.ts";
import type { Knowledge } from "./knowledge.ts";

const project = z.object({ projectId: Id }),
  kb = project.extend({ kbId: Id }),
  item = kb.extend({ id: Id }),
  ok = z.object({ ok: z.literal(true) });
const root = "/api/v1/projects/{projectId}/knowledge";
export function registerKnowledgeRoutes(
  app: OpenAPIHono<{ Variables: { principal: Principal } }>,
  knowledge: Knowledge,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: root,
      operationId: "listKnowledgeBases",
      request: { params: project },
      responses: { 200: json(z.array(KnowledgeBase)), ...errors },
    }),
    async (c) =>
      c.json(await knowledge.list(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: root,
      operationId: "createKnowledgeBase",
      request: { params: project, body: body(KnowledgeInput) },
      responses: { 200: json(KnowledgeBase), ...errors },
    }),
    async (c) =>
      c.json(
        await knowledge.create(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{kbId}/documents`,
      operationId: "listKnowledgeDocuments",
      request: { params: kb, query: PageQuery },
      responses: { 200: pageJson(KnowledgeDocument), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      const page = await knowledge.documents(
        c.get("principal"),
        p.projectId,
        p.kbId,
        c.req.valid("query"),
      );
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      return c.json(page.items, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{kbId}/documents`,
      operationId: "uploadKnowledgeDocument",
      request: { params: kb, body: body(DocumentInput) },
      responses: { 200: json(KnowledgeDocument), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await knowledge.upload(c.get("principal"), p.projectId, p.kbId, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{kbId}/documents/{id}/retry`,
      operationId: "retryKnowledgeDocument",
      request: { params: item, body: body(z.object({}).strict()) },
      responses: { 200: json(KnowledgeDocument), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await knowledge.retry(c.get("principal"), p.projectId, p.kbId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{kbId}/documents/{id}/delete`,
      operationId: "deleteKnowledgeDocument",
      request: { params: item, body: body(z.object({}).strict()) },
      responses: { 200: json(ok), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      await knowledge.removeDocument(c.get("principal"), p.projectId, p.kbId, p.id);
      return c.json({ ok: true as const }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{kbId}/documents/{id}/chunks`,
      operationId: "listKnowledgeChunks",
      request: { params: item },
      responses: { 200: json(z.array(KnowledgeChunk)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await knowledge.chunks(c.get("principal"), p.projectId, p.kbId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{kbId}/searches`,
      operationId: "searchKnowledge",
      request: { params: kb, body: body(SearchInput) },
      responses: { 200: json(KnowledgeSearch), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await knowledge.search(c.get("principal"), p.projectId, p.kbId, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{kbId}/searches/{id}`,
      operationId: "getKnowledgeSearch",
      request: { params: item },
      responses: { 200: json(KnowledgeSearch), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await knowledge.getSearch(c.get("principal"), p.projectId, p.kbId, p.id), 200);
    },
  );
  app.post("/internal/runtime/knowledge/claim", async (c) =>
    c.json({ job: await knowledge.claim() }),
  );
  app.post("/internal/runtime/knowledge/:id/heartbeat", async (c) => {
    const input = z.object({ leaseToken: z.string() }).parse(await c.req.json());
    await knowledge.renew(Id.parse(c.req.param("id")), input.leaseToken);
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/knowledge/:id/chunks", async (c) => {
    await knowledge.batch(Id.parse(c.req.param("id")), KnowledgeBatch.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/knowledge/:id/query", async (c) =>
    c.json({
      hits: await knowledge.queryJob(
        Id.parse(c.req.param("id")),
        VectorQuery.parse(await c.req.json()),
      ),
    }),
  );
  app.post("/internal/runtime/knowledge/:id/finish", async (c) => {
    await knowledge.finish(Id.parse(c.req.param("id")), KnowledgeFinish.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/runs/:id/knowledge", async (c) =>
    c.json({
      hits: await knowledge.queryAgent(
        Id.parse(c.req.param("id")),
        VectorQuery.parse(await c.req.json()),
      ),
    }),
  );
}
