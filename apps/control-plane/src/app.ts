import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  Agent,
  AgentInput,
  AgentUpdate,
  Application,
  Conversation,
  ConversationInput,
  ErrorBody,
  Id,
  Message,
  Model,
  ModelInput,
  Principal,
  Project,
  ProjectInput,
  Release,
  Run,
  RunEvent,
  RunInput,
  RuntimeEventInput,
  RuntimeFinishInput,
  RuntimeInfo,
  Tool,
  ToolInput,
  z,
} from "@platform/contracts";
import type { UIMessageChunk } from "ai";
import { createUIMessageStreamResponse, uiMessageChunkSchema } from "ai";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureEqual } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { Knowledge } from "./knowledge.ts";
import { registerKnowledgeRoutes } from "./knowledge-routes.ts";
import { Mcp } from "./mcp.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import { Queue } from "./queue.ts";
import type { Store } from "./store.ts";

const projectParams = z.object({ projectId: Id }),
  itemParams = projectParams.extend({ id: Id });
const json = <T extends z.ZodType>(schema: T) => ({
  description: "成功",
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const errors = {
  400: json(ErrorBody),
  401: json(ErrorBody),
  403: json(ErrorBody),
  404: json(ErrorBody),
  409: json(ErrorBody),
  429: json(ErrorBody),
  503: json(ErrorBody),
};
const loginInput = z
  .object({
    username: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{3,50}$/),
    password: z.string().min(12).max(200),
  })
  .strict();
export interface AppConfig {
  origin: string;
  runtimeToken: string;
  secureCookie?: boolean;
}
export function createApp(store: Store, config: AppConfig) {
  const app = new OpenAPIHono<{ Variables: { principal: Principal } }>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ code: "INVALID_INPUT", message: "请求字段不符合约束，请检查输入" }, 400);
    },
  });
  const queue = new Queue(store.db, store.vault, store.runtimeId);
  const knowledge = new Knowledge(store);
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
    console.error(
      "Control plane request failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return c.json({ code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" }, 503);
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && origin !== config.origin)
        throw new ApiError(403, "ORIGIN_DENIED", "请求来源不被允许");
      if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
        throw new ApiError(400, "CONTENT_TYPE", "请求必须使用 JSON");
    }
    if (c.req.path.startsWith("/api/v1/auth/")) return next();
    const actor = c.req.header("authorization")?.startsWith("Platform-HMAC ")
      ? await store.application(c.req.raw)
      : await store.session(getCookie(c, "platform_session") ?? "");
    c.set("principal", actor);
    await next();
  });
  const authTimes: number[] = [];
  app.use("/api/v1/auth/*", async (c, next) => {
    if (c.req.method === "POST") {
      const now = Date.now();
      while (authTimes[0] < now - 60000) authTimes.shift();
      if (authTimes.length >= 20)
        throw new ApiError(429, "RATE_LIMITED", "尝试次数过多，请稍后重试");
      authTimes.push(now);
    }
    await next();
  });
  const cookie = (c: Parameters<typeof setCookie>[0], token: string) =>
    setCookie(c, "platform_session", token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: !!config.secureCookie,
      path: "/",
      maxAge: 43200,
    });
  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      operationId: "health",
      responses: { 200: json(z.object({ status: z.literal("ok") })) },
    }),
    async (c) => {
      await store.db.query("SELECT 1");
      return c.json({ status: "ok" as const }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/auth/status",
      operationId: "getSetupStatus",
      responses: { 200: json(z.object({ initialized: z.boolean() })), ...errors },
    }),
    async (c) => c.json({ initialized: await store.isSetup() }, 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/setup",
      operationId: "setupPlatform",
      request: {
        body: body(loginInput.extend({ workspaceName: z.string().trim().min(1).max(80) })),
      },
      responses: { 200: json(Principal), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      await store.setup(input.username, input.password, input.workspaceName);
      const token = await store.login(input.username, input.password);
      cookie(c, token);
      return c.json(await store.session(token), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/login",
      operationId: "login",
      request: { body: body(loginInput) },
      responses: { 200: json(Principal), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json"),
        token = await store.login(input.username, input.password);
      cookie(c, token);
      return c.json(await store.session(token), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/logout",
      operationId: "logout",
      request: { body: body(z.object({}).strict()) },
      responses: { 200: json(z.object({ ok: z.boolean() })), ...errors },
    }),
    async (c) => {
      await store.logout(getCookie(c, "platform_session") ?? "");
      deleteCookie(c, "platform_session", { path: "/" });
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me",
      operationId: "getCurrentUser",
      responses: { 200: json(Principal), ...errors },
    }),
    (c) => c.json(c.get("principal"), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects",
      operationId: "listProjects",
      responses: { 200: json(z.array(Project)), ...errors },
    }),
    async (c) => c.json(await store.projects(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects",
      operationId: "createProject",
      request: { body: body(ProjectInput) },
      responses: { 200: json(Project), ...errors },
    }),
    async (c) => c.json(await store.createProject(c.get("principal"), c.req.valid("json")), 200),
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
      c.json(await store.models(c.get("principal"), c.req.valid("param").projectId), 200),
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
      checkUrl(input.baseUrl);
      return c.json(
        await store.createModel(c.get("principal"), c.req.valid("param").projectId, input),
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
    async (c) => c.json(await store.tools(c.get("principal"), c.req.valid("param").projectId), 200),
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
      if (input.kind === "http_get") checkUrl(input.url);
      if (input.kind === "sum") {
        input.inputSchema = {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 100 },
          },
          required: ["values"],
          additionalProperties: false,
        };
        input.outputSchema = {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
          additionalProperties: false,
        };
      }
      return c.json(
        await store.createTool(c.get("principal"), c.req.valid("param").projectId, input),
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
    async (c) =>
      c.json(await store.agents(c.get("principal"), c.req.valid("param").projectId), 200),
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
        await store.createAgent(
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
        await store.updateAgent(c.get("principal"), projectId, id, input, baseRevision),
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
        await store.publish(c.get("principal"), projectId, id, c.req.valid("json").baseRevision),
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
      return c.json(await store.releases(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations",
      operationId: "listConversations",
      request: { params: projectParams },
      responses: { 200: json(z.array(Conversation)), ...errors },
    }),
    async (c) =>
      c.json(await store.conversations(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/conversations",
      operationId: "createConversation",
      request: { params: projectParams, body: body(ConversationInput) },
      responses: { 200: json(Conversation), ...errors },
    }),
    async (c) => {
      const { agentId, title } = c.req.valid("json");
      return c.json(
        await store.createConversation(
          c.get("principal"),
          c.req.valid("param").projectId,
          agentId,
          title,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/messages",
      operationId: "listMessages",
      request: { params: itemParams },
      responses: { 200: json(z.array(Message)), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        z.array(Message).parse(await store.messages(c.get("principal"), projectId, id)),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/runs",
      operationId: "createRun",
      request: { params: projectParams, body: body(RunInput) },
      responses: { 200: json(Run), ...errors },
    }),
    async (c) => {
      const { conversationId, input, requestId } = c.req.valid("json");
      return c.json(
        await store.createRun(
          c.get("principal"),
          c.req.valid("param").projectId,
          conversationId,
          input,
          requestId,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/runs",
      operationId: "listRuns",
      request: { params: projectParams },
      responses: { 200: json(z.array(Run)), ...errors },
    }),
    async (c) => c.json(await store.runs(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/runs/{id}",
      operationId: "getRun",
      request: { params: itemParams },
      responses: { 200: json(Run), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await store.run(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/runs/{id}/events",
      operationId: "listRunEvents",
      request: {
        params: itemParams,
        query: z.object({ after: z.coerce.number().int().min(-1).default(-1) }),
      },
      responses: { 200: json(z.array(RunEvent)), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await store.events(c.get("principal"), projectId, id, c.req.valid("query").after),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/runs/{id}/cancel",
      operationId: "cancelRun",
      request: { params: itemParams, body: body(z.object({}).strict()) },
      responses: { 200: json(Run), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await store.cancel(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtimes",
      operationId: "listRuntimes",
      responses: { 200: json(z.array(RuntimeInfo)), ...errors },
    }),
    async (c) => c.json(await store.runtimes(c.get("principal")), 200),
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
      c.json(await store.applications(c.get("principal"), c.req.valid("param").projectId), 200),
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
        await store.createApplication(
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
      await store.revokeApplication(c.get("principal"), projectId, id);
      return c.json({ ok: true }, 200);
    },
  );
  const chatBody = z
    .object({
      messages: z.array(Message).min(1).max(300),
      id: z.string().optional(),
      trigger: z.string().optional(),
      messageId: z.string().optional(),
    })
    .passthrough();
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/conversations/{id}/chat",
      operationId: "streamConversation",
      request: { params: itemParams, body: body(chatBody) },
      responses: {
        200: {
          description: "AI SDK UI message stream",
          content: { "text/event-stream": { schema: z.string() } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param"),
        input = c.req.valid("json"),
        last = input.messages.at(-1);
      if (
        last?.role !== "user" ||
        last.parts.some((p) => p.type !== "text" || typeof p.text !== "string")
      )
        throw new ApiError(400, "TEXT_MESSAGE_REQUIRED", "当前仅支持文本消息");
      const prompt = last.parts
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (!prompt || prompt.length > 16000)
        throw new ApiError(400, "INVALID_MESSAGE", "消息为空或过长");
      const actor = c.get("principal"),
        run = await store.createRun(actor, projectId, id, prompt, last.id);
      let stopped = false,
        after = -1,
        errorSent = false;
      const stream = new ReadableStream<UIMessageChunk>({
        async start(controller) {
          try {
            while (!stopped) {
              // Read status first: a terminal state guarantees all prior events are committed.
              const current = await store.run(actor, projectId, run.id);
              const events = await store.events(actor, projectId, run.id, after);
              for (const event of events) {
                const checked = await uiMessageChunkSchema().validate?.(event.chunk);
                if (!checked?.success) throw new Error("Invalid stream event");
                const chunk = checked.value;
                controller.enqueue(chunk);
                if (chunk.type === "error") errorSent = true;
                after = event.seq;
              }
              if (!["queued", "running"].includes(current.status) && events.length < 500) {
                if (current.status === "failed" && !errorSent)
                  controller.enqueue({
                    type: "error",
                    errorText: `运行失败：${current.errorCode ?? "UNKNOWN"}`,
                  });
                if (current.status === "cancelled") controller.enqueue({ type: "abort" });
                controller.close();
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          } catch {
            if (!stopped) {
              controller.enqueue({ type: "error", errorText: "连接中断，请查看运行记录" });
              controller.close();
            }
          }
        },
        cancel() {
          stopped = true;
        },
      });
      return createUIMessageStreamResponse({
        stream,
        headers: { "x-platform-run-id": run.id, "cache-control": "no-store" },
      });
    },
  );
  app.use("/internal/*", async (c, next) => {
    if (
      !secureEqual(c.req.header("authorization") ?? "", `Bearer ${config.runtimeToken}`) ||
      c.req.header("x-runtime-id") !== store.runtimeId
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
  const mcp = new Mcp(store);
  registerMcpRoutes(app, mcp);
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Agent Platform API", version: "0.1.0" },
    servers: [{ url: "http://127.0.0.1:4110" }],
  });
  return { app, queue, knowledge, mcp };
}
function checkUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "INVALID_ENDPOINT", "请输入有效的 HTTP(S) 服务地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ApiError(
      400,
      "INVALID_ENDPOINT",
      "服务地址必须为 HTTP(S)，且不能包含凭据、查询参数或片段",
    );
}
