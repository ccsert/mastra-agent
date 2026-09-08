import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  Id,
  type Principal,
  VectorQuery,
  WorkflowAsset,
  WorkflowAssetInput,
  WorkflowAssetUpdate,
  WorkflowCapability,
  WorkflowGeneration,
  WorkflowGenerationInput,
  WorkflowIssue,
  WorkflowNodeFinish,
  WorkflowNodeRun,
  WorkflowRelease,
  WorkflowRun,
  WorkflowRunInput,
  WorkflowRuntimeFinish,
  z,
} from "@platform/contracts";
import { body, errors, json } from "./http.ts";
import { requireUser } from "./projects.ts";
import type { WorkflowQueue } from "./workflow-queue.ts";
import type { Workflows } from "./workflows.ts";

const project = z.object({ projectId: Id }),
  item = project.extend({ id: Id });
const revision = z.object({ baseRevision: z.number().int().positive() }).strict();
const empty = z.object({}).strict();
const root = "/api/v1/projects/{projectId}/workflows",
  run = "/api/v1/projects/{projectId}/workflow-runs/{id}",
  generation = "/api/v1/projects/{projectId}/workflow-generations/{id}";
export function registerWorkflowRoutes(
  app: OpenAPIHono<{ Variables: { principal: Principal } }>,
  service: Workflows,
  queue: WorkflowQueue,
) {
  app.openapi(
    createRoute({
      method: "get",
      path: root,
      operationId: "listWorkflows",
      request: { params: project },
      responses: { 200: json(z.array(WorkflowAsset)), ...errors },
    }),
    async (c) =>
      c.json(await service.list(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: root,
      operationId: "createWorkflow",
      request: { params: project, body: body(WorkflowAssetInput) },
      responses: { 200: json(WorkflowAsset), ...errors },
    }),
    async (c) =>
      c.json(
        await service.create(
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
      path: `${root}/catalog`,
      operationId: "getWorkflowCatalog",
      request: { params: project },
      responses: { 200: json(z.array(WorkflowCapability)), ...errors },
    }),
    async (c) =>
      c.json(await service.catalog(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}`,
      operationId: "getWorkflow",
      request: { params: item },
      responses: { 200: json(WorkflowAsset), ...errors },
    }),
    async (c) => {
      requireUser(c.get("principal"));
      const p = c.req.valid("param");
      return c.json(await service.asset(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: `${root}/{id}`,
      operationId: "updateWorkflow",
      request: { params: item, body: body(WorkflowAssetUpdate) },
      responses: { 200: json(WorkflowAsset), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param"),
        { baseRevision, ...input } = c.req.valid("json");
      return c.json(
        await service.update(c.get("principal"), p.projectId, p.id, input, baseRevision),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/validate`,
      operationId: "validateWorkflow",
      request: { params: item, body: body(revision) },
      responses: { 200: json(z.object({ issues: z.array(WorkflowIssue) })), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.validate(
          c.get("principal"),
          p.projectId,
          p.id,
          c.req.valid("json").baseRevision,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/publish`,
      operationId: "publishWorkflow",
      request: { params: item, body: body(revision) },
      responses: { 200: json(WorkflowRelease), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.publish(
          c.get("principal"),
          p.projectId,
          p.id,
          c.req.valid("json").baseRevision,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}/releases`,
      operationId: "listWorkflowReleases",
      request: { params: item },
      responses: { 200: json(z.array(WorkflowRelease)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await service.releases(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}/runs`,
      operationId: "listWorkflowRuns",
      request: { params: item },
      responses: { 200: json(z.array(WorkflowRun)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await service.runs(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/runs`,
      operationId: "createWorkflowRun",
      request: { params: item, body: body(WorkflowRunInput) },
      responses: { 200: json(WorkflowRun), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.createRun(c.get("principal"), p.projectId, p.id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: run,
      operationId: "getWorkflowRun",
      request: { params: item },
      responses: { 200: json(WorkflowRun), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await service.run(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${run}/nodes`,
      operationId: "listWorkflowNodeRuns",
      request: { params: item },
      responses: { 200: json(z.array(WorkflowNodeRun)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await queue.nodes(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${run}/cancel`,
      operationId: "cancelWorkflowRun",
      request: { params: item, body: body(empty) },
      responses: { 200: json(WorkflowRun), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      await queue.cancel(c.get("principal"), p.projectId, p.id, "execute");
      return c.json(await service.run(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${root}/{id}/generations`,
      operationId: "generateWorkflow",
      request: { params: item, body: body(WorkflowGenerationInput) },
      responses: { 200: json(WorkflowGeneration), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.generate(c.get("principal"), p.projectId, p.id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${root}/{id}/generations`,
      operationId: "listWorkflowGenerations",
      request: { params: item },
      responses: { 200: json(z.array(WorkflowGeneration)), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await service.generations(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: generation,
      operationId: "getWorkflowGeneration",
      request: { params: item },
      responses: { 200: json(WorkflowGeneration), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(await service.generation(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${generation}/accept`,
      operationId: "acceptWorkflowGeneration",
      request: { params: item, body: body(revision) },
      responses: { 200: json(WorkflowAsset), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.accept(
          c.get("principal"),
          p.projectId,
          p.id,
          c.req.valid("json").baseRevision,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${generation}/cancel`,
      operationId: "cancelWorkflowGeneration",
      request: { params: item, body: body(empty) },
      responses: { 200: json(WorkflowGeneration), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      await queue.cancel(c.get("principal"), p.projectId, p.id, "generate");
      return c.json(await service.generation(c.get("principal"), p.projectId, p.id), 200);
    },
  );
  const lease = z.object({ leaseToken: z.string() }).strict();
  const nodeId = (value: string) =>
    z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .parse(value);
  app.post("/internal/runtime/workflows/claim", async (c) => c.json({ job: await queue.claim() }));
  app.post("/internal/runtime/workflows/:id/heartbeat", async (c) =>
    c.json(
      await queue.renew(Id.parse(c.req.param("id")), lease.parse(await c.req.json()).leaseToken),
    ),
  );
  app.post("/internal/runtime/workflows/:id/finish", async (c) => {
    await queue.finish(
      Id.parse(c.req.param("id")),
      WorkflowRuntimeFinish.parse(await c.req.json()),
    );
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/workflows/:id/nodes/:nodeId/start", async (c) =>
    c.json(
      await queue.startNode(
        Id.parse(c.req.param("id")),
        nodeId(c.req.param("nodeId")),
        lease.parse(await c.req.json()).leaseToken,
      ),
    ),
  );
  app.post("/internal/runtime/workflows/:id/nodes/:nodeId/finish", async (c) => {
    await queue.finishNode(
      Id.parse(c.req.param("id")),
      nodeId(c.req.param("nodeId")),
      WorkflowNodeFinish.parse(await c.req.json()),
    );
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/workflows/:id/nodes/:nodeId/mcp", async (c) => {
    const input = lease.extend({ toolId: Id }).parse(await c.req.json());
    return c.json(
      await queue.authorizeMcp(
        Id.parse(c.req.param("id")),
        nodeId(c.req.param("nodeId")),
        input.leaseToken,
        input.toolId,
      ),
    );
  });
  app.post("/internal/runtime/workflows/:id/nodes/:nodeId/knowledge", async (c) =>
    c.json({
      hits: await queue.queryKnowledge(
        Id.parse(c.req.param("id")),
        nodeId(c.req.param("nodeId")),
        VectorQuery.parse(await c.req.json()),
      ),
    }),
  );
}
