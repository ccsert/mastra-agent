import { createRoute } from "@hono/zod-openapi";
import {
  Model,
  ModelDiscoverInput,
  ModelDiscovery,
  ModelInput,
  ModelProbe,
  ModelProbeInput,
  ModelUpdate,
  ModelVendorPreset,
  Tool,
  ToolInput,
  ToolProbe,
  ToolProbeInput,
  ToolUpdate,
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
import type { Resources } from "./resources.ts";
export function registerResourceRoutes(app: ApiApp, resources: Resources) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/models",
      operationId: "listModels",
      request: { params: projectParams },
      responses: { 200: json(z.array(Model)), ...errors },
    }),
    async (c) =>
      c.json(await resources.models(c.get("principal"), c.req.valid("param").projectId), 200),
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
      return c.json(
        await resources.createModel(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/projects/{projectId}/models/{id}",
      operationId: "updateModel",
      request: { params: itemParams, body: body(ModelUpdate) },
      responses: { 200: json(Model), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json"),
        { projectId, id } = c.req.valid("param");
      return c.json(await resources.updateModel(c.get("principal"), projectId, id, input), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/models/probe",
      operationId: "probeModel",
      description:
        "从平台侧按 Runtime 实际使用的方式探测模型服务。outcome 为 unreachable 时表示平台网络不可达，不代表 Runtime 不可达。",
      request: { params: projectParams, body: body(ModelProbeInput) },
      responses: { 200: json(ModelProbe), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await resources.probeModel(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/models/discovery",
      operationId: "discoverModels",
      description:
        "读取模型服务提供的模型列表，用于在控制台中选择模型 ID。列表只说明服务声明了哪些 ID，不表示它们可用或具备某种能力；outcome 为 unsupported 表示服务未提供该接口。",
      request: { params: projectParams, body: body(ModelDiscoverInput) },
      responses: { 200: json(ModelDiscovery), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await resources.discoverModels(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/model-vendors",
      operationId: "listModelVendors",
      description:
        "平台的供应商预设目录。仅包含 OpenAI 兼容接口；baseUrl 为 null 表示需自行填写，note 记录地址本身看不出的限制。",
      responses: { 200: json(z.array(ModelVendorPreset)), ...errors },
    }),
    async (c) => c.json(resources.vendors(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/tools",
      operationId: "listTools",
      request: { params: projectParams },
      responses: { 200: json(z.array(Tool)), ...errors },
    }),
    async (c) =>
      c.json(await resources.tools(c.get("principal"), c.req.valid("param").projectId), 200),
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
      return c.json(
        await resources.createTool(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/projects/{projectId}/tools/{id}",
      operationId: "updateTool",
      description: "MCP 工具不可编辑：它是远端描述符的固定投影，编辑会让它与所声明的描述符不一致。",
      request: { params: itemParams, body: body(ToolUpdate) },
      responses: { 200: json(Tool), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json"),
        { projectId, id } = c.req.valid("param");
      return c.json(await resources.updateTool(c.get("principal"), projectId, id, input), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/projects/{projectId}/tools/probe",
      operationId: "probeTool",
      description:
        "按 Runtime 实际调用工具的方式执行一次，并校验返回是否符合声明的输出 schema。outcome 区分 invalid（样例参数不合格）、rejected（服务拒绝）、mismatch（返回 JSON 但不符合 schema）与 unreachable（平台网络不通）。",
      request: { params: projectParams, body: body(ToolProbeInput) },
      responses: { 200: json(ToolProbe), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(
        await resources.probeTool(c.get("principal"), c.req.valid("param").projectId, input),
        200,
      );
    },
  );
}
