import { createRoute } from "@hono/zod-openapi";
import {
  Conversation,
  ConversationCapabilities,
  ConversationContext,
  ConversationInput,
  ConversationRunSummary,
  ConversationSession,
  ConversationTrace,
  ConversationUpdateInput,
  EditConversationInput,
  Id,
  Message,
  PageQuery,
  Run,
  RunArtifact,
  RunEvent,
  RunInput,
  RunWorkspace,
  SkillSelection,
  TaskFeedback,
  TaskFeedbackInput,
  TraceQuery,
  z,
} from "@platform/contracts";
import {
  type ApiApp,
  body,
  errors,
  itemParams,
  json,
  pageJson,
  projectParams,
} from "../../http/contracts.ts";
import { ApiError } from "../../infrastructure/errors.ts";
import { compactDeltaRuns } from "./compact.ts";
import type { Conversations } from "./conversations.ts";
import { conversationStream } from "./stream.ts";
export function registerConversationRoutes(app: ApiApp, conversations: Conversations) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/context",
      operationId: "getConversationContext",
      request: { params: itemParams },
      responses: { 200: json(ConversationContext), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await conversations.context(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/conversations/{id}/reset",
      operationId: "resetConversation",
      request: { params: itemParams, body: body(z.object({ requestId: Id }).strict()) },
      responses: { 200: json(Conversation), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await conversations.reset(c.get("principal"), projectId, id, c.req.valid("json").requestId),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/runs/{id}/feedback",
      operationId: "submitRunFeedback",
      request: { params: itemParams, body: body(TaskFeedbackInput) },
      responses: { 200: json(TaskFeedback), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await conversations.feedback(c.get("principal"), projectId, id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/conversations/{id}/edit",
      operationId: "editConversationMessage",
      request: { params: itemParams, body: body(EditConversationInput) },
      responses: { 200: json(Conversation), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await conversations.edit(c.get("principal"), projectId, id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/runs/{id}/workspace",
      operationId: "getRunWorkspace",
      request: { params: itemParams },
      responses: { 200: json(RunWorkspace), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        (await conversations.workspace(c.get("principal"), projectId, id)).workspace,
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/runs/{id}/artifacts/{artifactId}",
      operationId: "downloadRunArtifact",
      request: { params: itemParams.extend({ artifactId: RunArtifact.shape.id }) },
      responses: {
        200: {
          description: "Recorded tool result file",
          content: {
            "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { projectId, id, artifactId } = c.req.valid("param");
      const { files } = await conversations.workspace(c.get("principal"), projectId, id);
      const file = files.find((f) => f.metadata.id === artifactId);
      if (!file) throw new ApiError(404, "NOT_FOUND", "文件不存在");
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "content-type": `${file.metadata.mediaType}; charset=utf-8`,
          "content-disposition": `attachment; filename="result.${artifactId.split("-").at(-1)}"; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}`,
          "content-length": String(file.bytes.length),
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/session",
      operationId: "getConversationSession",
      request: { params: itemParams },
      responses: { 200: json(ConversationSession), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await conversations.session(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/stream",
      operationId: "resumeConversation",
      request: { params: itemParams, query: z.object({ runId: Id }) },
      responses: {
        200: {
          description: "Replay and follow the existing run",
          content: { "text/event-stream": { schema: z.string() } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param"),
        actor = c.get("principal");
      await conversations.get(actor, projectId, id);
      const run = await conversations.run(actor, projectId, c.req.valid("query").runId);
      if (run.conversationId !== id) throw new ApiError(404, "NOT_FOUND", "运行不存在");
      return conversationStream(conversations, actor, projectId, run);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversation-runs",
      operationId: "listConversationRunSummaries",
      request: { params: projectParams, query: PageQuery },
      responses: { 200: pageJson(ConversationRunSummary), ...errors },
    }),
    async (c) => {
      const page = await conversations.summaries(
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
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/trajectory",
      operationId: "getConversationTrace",
      request: { params: itemParams, query: TraceQuery },
      responses: { 200: json(ConversationTrace), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await conversations.trace(c.get("principal"), projectId, id, c.req.valid("query")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/capabilities",
      operationId: "getConversationCapabilities",
      request: { params: itemParams },
      responses: { 200: json(ConversationCapabilities), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await conversations.capabilities(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}/runs",
      operationId: "listConversationRuns",
      request: { params: itemParams, query: PageQuery },
      responses: { 200: pageJson(Run), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      const page = await conversations.runs(
        c.get("principal"),
        projectId,
        c.req.valid("query"),
        id,
      );
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      return c.json(page.items, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations",
      operationId: "listConversations",
      request: {
        params: projectParams,
        query: PageQuery.extend({ pinned: z.enum(["true"]).optional() }),
      },
      responses: { 200: pageJson(Conversation), ...errors },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const page = await conversations.list(
        c.get("principal"),
        c.req.valid("param").projectId,
        query,
        {
          pinned: query.pinned === "true",
        },
      );
      if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
      return c.json(page.items, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/conversations/{id}",
      operationId: "getConversation",
      request: { params: itemParams },
      responses: { 200: json(Conversation), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await conversations.get(c.get("principal"), projectId, id), 200);
    },
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
      method: "delete",
      path: "/api/v1/projects/{projectId}/conversations/{id}",
      operationId: "deleteConversation",
      request: { params: itemParams, body: body(z.object({}).strict()) },
      responses: { 200: json(z.object({ id: Id })), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await conversations.remove(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/projects/{projectId}/conversations/{id}",
      operationId: "updateConversation",
      request: { params: itemParams, body: body(ConversationUpdateInput) },
      responses: { 200: json(Conversation), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await conversations.update(c.get("principal"), projectId, id, c.req.valid("json")),
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
      const { conversationId, input, requestId, skillVersionIds } = c.req.valid("json");
      return c.json(
        await conversations.createRun(
          c.get("principal"),
          c.req.valid("param").projectId,
          conversationId,
          input,
          requestId,
          skillVersionIds,
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
        query: z.object({
          after: z.coerce.number().int().min(-1).default(-1),
          through: z.coerce.number().int().min(-1).optional(),
          // Trace readers merge token-level delta runs; raw protocol stays the default.
          compact: z.enum(["deltas"]).optional(),
        }),
      },
      responses: { 200: json(z.array(RunEvent)), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      const rows = await conversations.events(
        c.get("principal"),
        projectId,
        id,
        c.req.valid("query").after,
        c.req.valid("query").through,
      );
      return c.json(c.req.valid("query").compact === "deltas" ? compactDeltaRuns(rows) : rows, 200);
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
export function registerChatRoute(
  app: ApiApp,
  conversations: Conversations,
  assistantOnly = false,
) {
  const chatBody = z
    .object({
      messages: z
        .array(Message.omit({ metadata: true }))
        .min(1)
        .max(300),
      id: z.string().optional(),
      trigger: z.string().optional(),
      messageId: z.string().optional(),
      skillVersionIds: SkillSelection,
    })
    .passthrough();
  app.openapi(
    createRoute({
      method: "post",
      path: assistantOnly
        ? "/api/v1/projects/{projectId}/assistant/conversations/{id}/chat"
        : "/api/v1/projects/{projectId}/conversations/{id}/chat",
      operationId: assistantOnly ? "streamPlatformAssistant" : "streamConversation",
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
        run = await conversations.createRun(
          actor,
          projectId,
          id,
          prompt,
          last.id,
          input.skillVersionIds,
          assistantOnly,
        );
      return conversationStream(conversations, actor, projectId, run);
    },
  );
}
