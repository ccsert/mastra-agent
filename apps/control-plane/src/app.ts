import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Id,
  type Principal,
  RuntimeEventInput,
  RuntimeFinishInput,
  RuntimeTaskRequest,
  z,
} from "@platform/contracts";
import { createLogger, type Logger, requestId } from "@platform/operations";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { matchedRoutes } from "hono/route";
import { json } from "./http/contracts.ts";
import { secureEqual } from "./infrastructure/crypto.ts";
import { ApiError } from "./infrastructure/errors.ts";
import { registerAgentRoutes } from "./modules/agents/routes.ts";
import { registerApplicationRoutes } from "./modules/applications/routes.ts";
import { PlatformAssistant } from "./modules/assistant/index.ts";
import { registerAssistantRoutes } from "./modules/assistant/routes.ts";
import { Queue } from "./modules/conversations/index.ts";
import { registerChatRoute, registerConversationRoutes } from "./modules/conversations/routes.ts";
import { registerIdentityRoutes } from "./modules/identity/routes.ts";
import { Knowledge } from "./modules/knowledge/index.ts";
import { registerKnowledgeRoutes } from "./modules/knowledge/routes.ts";
import { Mcp } from "./modules/mcp/index.ts";
import { registerMcpRoutes } from "./modules/mcp/routes.ts";
import { registerMemberRoutes } from "./modules/members/routes.ts";
import { registerProjectRoutes } from "./modules/projects/routes.ts";
import { registerResourceRoutes } from "./modules/resources/routes.ts";
import { registerRuntimeRoutes } from "./modules/runtimes/routes.ts";
import { registerSkillRoutes, registerSkillRuntimeRoutes } from "./modules/skills/routes.ts";
import { WorkflowQueue, Workflows } from "./modules/workflows/index.ts";
import { registerWorkflowRoutes } from "./modules/workflows/routes.ts";
import type { Platform } from "./platform.ts";
import { authorizeProjectRequest } from "./project-authorization.ts";
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
      maxSize: /^\/internal\/runtime\/runs\/[^/]+\/task$/.test(c.req.path)
        ? 20 * 1024 * 1024
        : c.req.path.startsWith("/internal/")
          ? 8388608
          : /\/projects\/[^/]+\/skills$/.test(c.req.path)
            ? 5700000
            : /\/knowledge\/[^/]+\/document-previews$/.test(c.req.path)
              ? 12 * 1024 * 1024
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
    await authorizeProjectRequest(platform.projects.access, actor, c.req.path, c.req.method);
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
  registerIdentityRoutes(app, platform.identity, config.secureCookie, platform.members);
  registerMemberRoutes(app, platform.members, platform.projects.access);
  registerProjectRoutes(app, platform.projects);
  registerResourceRoutes(app, platform.resources);
  registerAgentRoutes(app, platform.agents);
  registerSkillRoutes(app, platform.skills);
  registerConversationRoutes(app, platform.conversations);
  registerRuntimeRoutes(app, platform.runtimes);
  registerApplicationRoutes(app, platform.applications);
  registerChatRoute(app, platform.conversations);
  app.use("/internal/*", async (c, next) => {
    const runtimeId = c.req.header("x-runtime-id") ?? "";
    const bearer = c.req.header("authorization") ?? "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    // The deployment's own runtime authenticates via config; registered
    // runtimes via their issued (hashed) token. Either can be disabled.
    const hosted =
      runtimeId === platform.runtimeId && secureEqual(bearer, `Bearer ${config.runtimeToken}`);
    if (!hosted) {
      if (!(await platform.runtimes.authenticate(runtimeId, token)))
        throw new ApiError(401, "RUNTIME_UNAUTHENTICATED", "Runtime 凭据无效");
    } else if (!(await platform.runtimes.hostedEnabled()))
      throw new ApiError(403, "RUNTIME_DISABLED", "Runtime 已停用");
    // Registered runtimes connect for lifecycle management; knowledge, MCP and
    // workflow job routing stays on the hosted runtime until profiles land.
    if (
      !hosted &&
      [
        "/internal/runtime/knowledge/claim",
        "/internal/runtime/mcp/claim",
        "/internal/runtime/workflows/claim",
      ].some((route) => c.req.path.startsWith(route))
    )
      throw new ApiError(403, "RUNTIME_ROUTING_UNAVAILABLE", "此类任务目前仅由托管 Runtime 认领");
    await next();
  });
  app.post("/internal/runtime/claim", async (c) =>
    c.json({ job: await queue.claim(c.req.header("x-runtime-id") ?? undefined) }),
  );
  app.post("/internal/runtime/runs/:id/heartbeat", async (c) => {
    const input = z.object({ leaseToken: z.string() }).parse(await c.req.json());
    return c.json(await queue.renew(Id.parse(c.req.param("id")), input.leaseToken));
  });
  app.post("/internal/runtime/runs/:id/events", async (c) => {
    const input = RuntimeEventInput.parse(await c.req.json());
    await queue.append(Id.parse(c.req.param("id")), input);
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/runs/:id/finish", async (c) => {
    await queue.finish(Id.parse(c.req.param("id")), RuntimeFinishInput.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post("/internal/runtime/runs/:id/task", async (c) =>
    c.json(
      await queue.task(Id.parse(c.req.param("id")), RuntimeTaskRequest.parse(await c.req.json())),
    ),
  );
  registerSkillRuntimeRoutes(app, platform.skills);
  registerKnowledgeRoutes(app, knowledge);
  const mcp = new Mcp(platform);
  registerMcpRoutes(app, mcp);
  const workflows = new Workflows(platform),
    workflowQueue = new WorkflowQueue(workflows, knowledge, platform, platform.skills);
  registerWorkflowRoutes(app, workflows, workflowQueue);
  const assistant = new PlatformAssistant(
    platform.db,
    { ...platform, knowledge, mcp, workflows },
    platform.conversations,
    platform.runtimeId,
  );
  registerAssistantRoutes(app, assistant, platform.conversations);
  registerChatRoute(app, platform.conversations, true);
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Agent Platform API", version: "0.1.0" },
    servers: [{ url: "/" }],
  });
  return { app, queue, knowledge, mcp, workflows, workflowQueue, assistant };
}
