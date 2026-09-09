import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Id, type Principal, RuntimeEventInput, RuntimeFinishInput, z } from "@platform/contracts";
import { createLogger, type Logger, requestId } from "@platform/operations";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { matchedRoutes } from "hono/route";
import { registerAccessRoutes } from "./access-routes.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerChatRoute, registerConversationRoutes } from "./conversation-routes.ts";
import { secureEqual } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { json } from "./http.ts";
import { registerIdentityRoutes } from "./identity-routes.ts";
import { Knowledge } from "./knowledge.ts";
import { registerKnowledgeRoutes } from "./knowledge-routes.ts";
import { Mcp } from "./mcp.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import type { Platform } from "./platform.ts";
import { Queue } from "./queue.ts";
import { registerResourceRoutes } from "./resource-routes.ts";
import { WorkflowQueue } from "./workflow-queue.ts";
import { registerWorkflowRoutes } from "./workflow-routes.ts";
import { Workflows } from "./workflows.ts";
export interface AppConfig {
  origin: string;
  additionalOrigins?: string[] | (() => string[]);
  runtimeToken: string;
  secureCookie?: boolean;
  logger?: Logger;
}
export function createApp(platform: Platform, config: AppConfig) {
  const additionalOrigins = config.additionalOrigins ?? [];
  const log = config.logger ?? createLogger("control-plane");
  const allowedOrigins = () => [
    config.origin,
    ...(typeof additionalOrigins === "function" ? additionalOrigins() : additionalOrigins),
  ];
  const app = new OpenAPIHono<{ Variables: { principal: Principal } }>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ code: "INVALID_INPUT", message: "请求字段不符合约束，请检查输入" }, 400);
    },
  });
  const queue = new Queue(platform.db, platform.vault, platform.runtimeId);
  const knowledge = new Knowledge(platform);
  app.use("*", async (c, next) => {
    const id = requestId(c.req.header("x-request-id")),
      start = performance.now();
    c.header("X-Request-Id", id);
    await next();
    const route =
      matchedRoutes(c).findLast((route) => !route.path.includes("*"))?.path ?? "unmatched";
    // Idle worker polling is frequent; retain failures and actual API work without noisy success polls.
    if (
      c.res.status >= 400 ||
      (!route.startsWith("/internal/") && route !== "/health" && route !== "/ready")
    )
      log({
        event: "http_request",
        requestId: id,
        method: c.req.method,
        route,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      });
  });
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path.startsWith("/internal/")
        ? 8388608
        : /\/knowledge\/[^/]+\/documents$/.test(c.req.path)
          ? 1048576
          : 262144,
      onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", message: "请求内容过大" }, 400),
    })(c, next),
  );
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json({ code: error.code, message: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json({ code: "INVALID_INPUT", message: "请求或存储数据不符合约束" }, 400);
    return c.json({ code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" }, 503);
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && !allowedOrigins().includes(origin))
        throw new ApiError(403, "ORIGIN_DENIED", "请求来源不被允许");
      if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
        throw new ApiError(400, "CONTENT_TYPE", "请求必须使用 JSON");
    }
    if (c.req.path.startsWith("/api/v1/auth/")) return next();
    const actor = c.req.header("authorization")?.startsWith("Platform-HMAC ")
      ? await platform.applications.authenticate(c.req.raw)
      : await platform.identity.session(getCookie(c, "platform_session") ?? "");
    c.set("principal", actor);
    await next();
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      operationId: "health",
      responses: { 200: json(z.object({ status: z.literal("ok") })) },
    }),
    async (c) => {
      await platform.db.query("SELECT 1");
      return c.json({ status: "ok" as const }, 200);
    },
  );
  app.get("/ready", async (c) => {
    await platform.db.query("SELECT 1");
    return c.json({ status: "ready" });
  });
  registerIdentityRoutes(app, platform.identity, config.secureCookie);
  registerResourceRoutes(app, platform.projects, platform.resources);
  registerAgentRoutes(app, platform.agents);
  registerConversationRoutes(app, platform.conversations);
  registerAccessRoutes(app, platform.applications, platform.runtimes);
  registerChatRoute(app, platform.conversations);
  app.use("/internal/*", async (c, next) => {
    if (
      !secureEqual(c.req.header("authorization") ?? "", `Bearer ${config.runtimeToken}`) ||
      c.req.header("x-runtime-id") !== platform.runtimeId
    )
      throw new ApiError(401, "RUNTIME_UNAUTHENTICATED", "Runtime 凭据无效");
    await next();
  });
  app.post("/internal/runtime/claim", async (c) => c.json({ job: await queue.claim() }));
  app.post("/internal/runtime/runs/:id/heartbeat", async (c) => {
    const input = z.object({ leaseToken: z.string() }).parse(await c.req.json());
    return c.json(await queue.renew(Id.parse(c.req.param("id")), input.leaseToken));
  });
  app.post("/internal/runtime/runs/:id/events", async (c) => {
    const input = RuntimeEventInput.parse(await c.req.json());
    await queue.append(Id.parse(c.req.param("id")), input.leaseToken, input.seq, input.chunk);
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/runs/:id/finish", async (c) => {
    await queue.finish(Id.parse(c.req.param("id")), RuntimeFinishInput.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  registerKnowledgeRoutes(app, knowledge);
  const mcp = new Mcp(platform);
  registerMcpRoutes(app, mcp);
  const workflows = new Workflows(platform),
    workflowQueue = new WorkflowQueue(workflows, knowledge, platform);
  registerWorkflowRoutes(app, workflows, workflowQueue);
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Agent Platform API", version: "0.1.0" },
    servers: [{ url: "/" }],
  });
  return { app, queue, knowledge, mcp, workflows, workflowQueue };
}
