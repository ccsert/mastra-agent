import { createRoute } from "@hono/zod-openapi";
import {
  AgentAppCompletion,
  AgentAppReceipt,
  AgentAppRegistration,
  AgentAppRegistrationView,
  AgentAppSync,
  AgentAppSyncInput,
  AssistantBootstrap,
  AssistantCapabilities,
  AssistantOperationDetail,
  AssistantProposal,
  AssistantSession,
  AssistantSettingsInput,
  AssistantStartInput,
  AssistantToolRequest,
  AssistantUiReceipt,
  AssistantUiResultInput,
  AssistantUiSync,
  AssistantUiSyncInput,
  Id,
  Run,
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
import type { Conversations } from "../conversations/index.ts";
import type { PlatformAssistant } from "./assistant.ts";
export function registerAssistantRoutes(
  app: ApiApp,
  assistant: PlatformAssistant,
  conversations: Conversations,
) {
  const base = "/api/v1/projects/{projectId}/assistant";
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/apps`,
      operationId: "listAssistantApps",
      request: { params: projectParams },
      responses: { 200: json(z.array(AgentAppRegistrationView)), ...errors },
    }),
    async (c) =>
      c.json(await assistant.apps(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/apps`,
      operationId: "registerAssistantApp",
      request: { params: projectParams, body: body(AgentAppRegistration) },
      responses: { 200: json(AgentAppRegistrationView), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.registerApp(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: `${base}/apps/{id}`,
      operationId: "removeAssistantApp",
      request: { params: itemParams },
      responses: { 200: json(z.object({ removed: z.boolean() })), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.removeApp(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("param").id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions/{id}/apps/sync`,
      operationId: "syncAssistantApp",
      request: { params: itemParams, body: body(AgentAppSyncInput) },
      responses: { 200: json(AgentAppSync), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.syncApp(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions/{id}/apps/actions/{actionId}`,
      operationId: "completeAssistantApp",
      request: { params: itemParams.extend({ actionId: Id }), body: body(AgentAppCompletion) },
      responses: { 200: json(AgentAppReceipt), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.completeApp(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("param").id,
          c.req.valid("param").actionId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions/{id}/ui`,
      operationId: "syncAssistantUi",
      request: { params: itemParams, body: body(AssistantUiSyncInput) },
      responses: { 200: json(AssistantUiSync), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(
        await assistant.syncUi(c.get("principal"), projectId, id, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions/{id}/ui/{actionId}`,
      operationId: "completeAssistantUi",
      request: { params: itemParams.extend({ actionId: Id }), body: body(AssistantUiResultInput) },
      responses: { 200: json(AssistantUiReceipt), ...errors },
    }),
    async (c) => {
      const { projectId, id, actionId } = c.req.valid("param");
      return c.json(
        await assistant.completeUi(
          c.get("principal"),
          projectId,
          id,
          actionId,
          c.req.valid("json"),
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: base,
      operationId: "getPlatformAssistant",
      request: { params: projectParams },
      responses: { 200: json(AssistantBootstrap), ...errors },
    }),
    async (c) =>
      c.json(await assistant.bootstrap(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/capabilities`,
      operationId: "getAssistantCapabilities",
      request: { params: projectParams, query: z.object({ conversationId: Id.optional() }) },
      responses: { 200: json(AssistantCapabilities), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.capabilities(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("query").conversationId,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: `${base}/capabilities/operations/{operationId}`,
      operationId: "getAssistantOperation",
      request: { params: projectParams.extend({ operationId: z.string().min(1).max(80) }) },
      responses: { 200: json(AssistantOperationDetail), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.capabilityOperation(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("param").operationId,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/settings`,
      operationId: "configurePlatformAssistant",
      request: { params: projectParams, body: body(AssistantSettingsInput) },
      responses: { 200: json(AssistantBootstrap), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.configure(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("json").modelId,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions`,
      operationId: "startPlatformAssistant",
      request: { params: projectParams, body: body(AssistantStartInput) },
      responses: { 200: json(AssistantSession), ...errors },
    }),
    async (c) =>
      c.json(
        await assistant.start(
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
      path: `${base}/sessions/{id}/proposals`,
      operationId: "listAssistantProposals",
      request: { params: itemParams },
      responses: { 200: json(z.array(AssistantProposal)), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      return c.json(await assistant.proposals(c.get("principal"), projectId, id), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/sessions/{id}/proposals/{proposalId}`,
      operationId: "applyAssistantProposal",
      request: {
        params: itemParams.extend({ proposalId: Id }),
        body: body(z.object({ dismiss: z.boolean().default(false) }).strict()),
      },
      responses: { 200: json(AssistantProposal), ...errors },
    }),
    async (c) => {
      const { projectId, id, proposalId } = c.req.valid("param");
      return c.json(
        await assistant.apply(
          c.get("principal"),
          projectId,
          id,
          proposalId,
          c.req.valid("json").dismiss,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: `${base}/runs/{id}/cancel`,
      operationId: "cancelAssistantRun",
      request: { params: itemParams, body: body(z.object({}).strict()) },
      responses: { 200: json(Run), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param"),
        actor = c.get("principal"),
        run = await conversations.run(actor, projectId, id);
      await assistant.session(actor, projectId, run.conversationId);
      return c.json(await conversations.cancel(actor, projectId, id), 200);
    },
  );
  app.post("/internal/runtime/runs/:id/assistant", async (c) =>
    c.json(
      await assistant.runtime(
        Id.parse(c.req.param("id")),
        AssistantToolRequest.parse(await c.req.json()),
      ),
    ),
  );
}
