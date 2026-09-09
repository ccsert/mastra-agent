import { createRoute } from "@hono/zod-openapi";
import {
  Conversation,
  ConversationInput,
  Message,
  PageQuery,
  Run,
  RunEvent,
  RunInput,
  z,
} from "@platform/contracts";
import type { UIMessageChunk } from "ai";
import { createUIMessageStreamResponse, uiMessageChunkSchema } from "ai";
import type { Conversations } from "./conversations.ts";
import { ApiError } from "./errors.ts";
import { type ApiApp, body, errors, itemParams, json, pageJson, projectParams } from "./http.ts";
export function registerConversationRoutes(app: ApiApp, conversations: Conversations) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations",
      operationId: "listConversations",
      request: { params: projectParams },
      responses: { 200: json(z.array(Conversation)), ...errors },
    }),
    async (c) =>
      c.json(await conversations.list(c.get("principal"), c.req.valid("param").projectId), 200),
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
        await conversations.create(
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
        z.array(Message).parse(await conversations.messages(c.get("principal"), projectId, id)),
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
        await conversations.createRun(
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
      request: { params: projectParams, query: PageQuery },
      responses: { 200: pageJson(Run), ...errors },
    }),
    async (c) => {
      const p = c.req.valid("param");
      const page = await conversations.runs(c.get("principal"), p.projectId, c.req.valid("query"));
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      return c.json(page.items, 200);
    },
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
      return c.json(await conversations.run(c.get("principal"), projectId, id), 200);
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
        await conversations.events(c.get("principal"), projectId, id, c.req.valid("query").after),
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
      return c.json(await conversations.cancel(c.get("principal"), projectId, id), 200);
    },
  );
}
export function registerChatRoute(app: ApiApp, conversations: Conversations) {
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
        run = await conversations.createRun(actor, projectId, id, prompt, last.id);
      let stopped = false,
        after = -1,
        errorSent = false;
      const stream = new ReadableStream<UIMessageChunk>({
        async start(controller) {
          try {
            while (!stopped) {
              // Read status first: a terminal state guarantees all prior events are committed.
              const current = await conversations.run(actor, projectId, run.id);
              const events = await conversations.events(actor, projectId, run.id, after);
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
}
