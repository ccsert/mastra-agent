import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Agent, Model } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { AgentEditor } from "../../src/features/agents/index.ts";
import { ModelEditor } from "../../src/features/models/index.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
/** Shaped like the real catalogue so vendor selection and its note can be asserted. */
const vendorCatalogue = [
  { vendor: "custom", label: "自定义（OpenAI 兼容）", baseUrl: null, note: "自定义地址说明" },
  {
    vendor: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    note: "DeepSeek 使用同一地址。",
  },
];
/**
 * The editor reads the vendor catalogue on mount. Answering it here keeps each
 * test's own handler from having to know about a request it did not ask for.
 */
const withVendorCatalogue =
  (handler: (request: Request) => Promise<Response>) =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    // Observe the exact request sent by the SDK, including its abort signal.
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/model-vendors"))
      return Response.json(vendorCatalogue);
    return handler(request);
  };
const registered: Model = {
  id: "model-1",
  projectId: "project",
  name: "内网 Qwen",
  baseUrl: "http://model.test/v1",
  modelId: "qwen3-27b",
  kind: "chat",
  vendor: "custom",
  capabilities: { vision: false, toolUse: true },
  hasCredential: true,
  provider: "openai-compatible",
  createdAt: "2026-09-09",
};
const agent: Agent = {
  id: "agent",
  projectId: "project",
  name: "编辑回归",
  description: "",
  modelId: "model",
  instructions: "读取规则后计算",
  toolIds: [],
  knowledgeBaseIds: [],
  skillBindings: [{ versionId: "skill", entrypoints: ["scripts/run.py"] }],
  maxSteps: 5,
  draftRevision: 7,
  publishedReleaseId: null,
  publishedVersion: null,
  createdAt: "2026-09-09",
};
test("Agent editor blocks failed Skill catalogs and preserves fixed bindings when saving after retry", async () => {
  let unavailable = true,
    saved: Record<string, unknown> | undefined,
    closed = 0;
  globalThis.fetch = async (input) => {
    const request = input as Request,
      url = new URL(request.url);
    if (request.method === "PUT") {
      saved = await request.json();
      return Response.json(agent);
    }
    if (url.pathname.endsWith("/skills"))
      return unavailable
        ? Response.json({ message: "Skill 目录读取失败" }, { status: 503 })
        : Response.json([
            {
              id: "skill",
              name: "report",
              version: 1,
              enabled: true,
              entrypoints: ["scripts/run.py"],
            },
          ]);
    if (url.pathname.endsWith("/models"))
      return Response.json([{ id: "model", name: "模型", modelId: "qwen", kind: "chat" }]);
    return Response.json([]);
  };
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="project">
          <AgentEditor
            projectId="project"
            agent={agent}
            onSaved={() => {}}
            onClose={() => closed++}
          />
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
  await screen.findAllByText("Skill 目录读取失败");
  const save = screen.getByRole("button", { name: "保存草稿" });
  assert.ok(save.hasAttribute("disabled"));
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));
  await waitFor(() => assert.ok(!save.hasAttribute("disabled")));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "修改后的名称" } });
  fireEvent.click(save);
  await waitFor(() => assert.ok(saved));
  assert.equal(closed, 0, "保存后保留工作区，便于继续试用");
  assert.deepEqual(saved?.skillBindings, agent.skillBindings);
  assert.equal(saved?.baseRevision, 7);
  assert.equal(saved?.modelId, "model");
});
test("the Agent editor warns before saving when the chosen model cannot call tools", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL((input as Request).url);
    if (url.pathname.endsWith("/models"))
      return Response.json([
        {
          id: "model",
          name: "无工具模型",
          modelId: "qwen",
          kind: "chat",
          capabilities: { vision: false, toolUse: false },
        },
      ]);
    if (url.pathname.endsWith("/tools"))
      return Response.json([{ id: "tool", name: "sum_values", description: "求和" }]);
    return Response.json([]);
  };
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="project">
          <AgentEditor
            projectId="project"
            // Bound to a tool while the model declares no tool use: the server
            // rejects this, so the editor must say why before the save attempt.
            agent={{ ...agent, modelId: "model", toolIds: ["tool"] }}
            onSaved={() => {}}
            onClose={() => {}}
          />
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
  await screen.findByText("所选模型被标记为不支持工具调用");
  assert.ok(screen.getByText(/知识检索、工具、计划和子代理需要模型支持工具调用/));
});
test("model editor retains configurable embedding dimensions and cancels a pending submission on close", async () => {
  let body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    late: ((r: Response) => void) | undefined,
    saved = 0;
  globalThis.fetch = withVendorCatalogue(async (req) => {
    body = await req.json();
    signal = req.signal;
    return new Promise((resolve) => {
      late = resolve;
    });
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => saved++} />
      </App>
    </ConfigProvider>,
  );
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "向量模型" } });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "http://model.test/v1" },
  });
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "embedding-model" } });
  fireEvent.mouseDown(screen.getByRole("combobox", { name: /服务能力/ }));
  fireEvent.click(await screen.findByText("向量 · Embeddings"));
  fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: "1024" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => assert.ok(body));
  assert.equal(body?.dimensions, 1024);
  assert.equal(body?.kind, "embedding");
  fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  await waitFor(() => assert.ok(signal?.aborted));
  late?.(Response.json({ id: "late" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, 0);
});
const fill = (values: { baseUrl: string; modelId: string; apiKey?: string }) => {
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "内网 Qwen" } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: values.baseUrl } });
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: values.modelId } });
  if (values.apiKey)
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: values.apiKey } });
};
test("the editor probes before saving and never presents a wrong configuration as the problem", async () => {
  let probed: Record<string, unknown> | undefined;
  globalThis.fetch = withVendorCatalogue(async (request) => {
    probed = await request.json();
    return Response.json({
      outcome: "rejected",
      httpStatus: 401,
      latencyMs: 14,
      message: "服务返回 401：Invalid fixture credential",
      dimensions: null,
    });
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  fill({ baseUrl: "http://model.test/v1", modelId: "qwen3-27b" });
  fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
  await screen.findByText("服务已响应，但拒绝了请求或格式不符");
  // The provider's own words and the measured facts are shown, not a paraphrase.
  assert.ok(screen.getByText(/Invalid fixture credential/));
  assert.ok(screen.getByText(/HTTP 401 · 用时 14 ms/));
  assert.equal(probed?.kind, "chat");
  assert.equal(probed?.baseUrl, "http://model.test/v1");
  assert.equal("apiKey" in (probed ?? {}), false);
});
test("an unreachable probe is reported as the platform's own network, not a model verdict", async () => {
  globalThis.fetch = withVendorCatalogue(async () =>
    Response.json({
      outcome: "unreachable",
      httpStatus: null,
      latencyMs: null,
      message: "平台无法连接该地址（ECONNREFUSED）。",
      dimensions: null,
    }),
  );
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  fill({ baseUrl: "http://model.test/v1", modelId: "qwen3-27b" });
  fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
  await screen.findByText("平台无法连接该地址");
  assert.ok(screen.getByText(/不要据此判断模型配置有误/));
});
test("editing prefills the model, sends a PATCH and keeps the stored key when it is left blank", async () => {
  let method: string | undefined,
    url: string | undefined,
    body: Record<string, unknown> | undefined;
  globalThis.fetch = withVendorCatalogue(async (request) => {
    method = request.method;
    url = request.url;
    body = await request.json();
    return Response.json(registered);
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor
          projectId="project"
          model={registered}
          onClose={() => view.unmount()}
          onSaved={() => {}}
        />
      </App>
    </ConfigProvider>,
  );
  assert.equal((screen.getByLabelText("名称") as HTMLInputElement).value, "内网 Qwen");
  assert.equal(
    (screen.getByLabelText("Base URL") as HTMLInputElement).value,
    "http://model.test/v1",
  );
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "内网 Qwen（新）" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => assert.ok(body));
  assert.equal(method, "PATCH");
  assert.ok(url?.endsWith("/api/v1/projects/project/models/model-1"), url);
  assert.equal(body?.name, "内网 Qwen（新）");
  assert.equal(body?.modelId, "qwen3-27b");
  assert.equal("apiKey" in (body ?? {}), false);
});
test("choosing a vendor fills its address, shows the caveat, and sends vendor with declared capabilities", async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = withVendorCatalogue(async (request) => {
    if (request.method === "POST") body = await request.json();
    return Response.json(registered);
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "DeepSeek 对话" } });
  // The catalogue request resolves after mount, so wait for the option to exist.
  fireEvent.mouseDown(screen.getByRole("combobox", { name: /供应商/ }));
  fireEvent.click(await screen.findByText("DeepSeek 官方"));
  // The address is prefilled and the note explains what the address does not.
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText("Base URL") as HTMLInputElement).value,
      "https://api.deepseek.com/v1",
    ),
  );
  assert.ok(screen.getByText("DeepSeek 使用同一地址。"));
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "deepseek-chat" } });
  // Turn the declared vision capability on; tool use stays at its default.
  fireEvent.click(screen.getByRole("switch", { name: /支持图片输入/ }));
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => assert.ok(body));
  assert.equal(body?.vendor, "deepseek");
  assert.deepEqual(body?.capabilities, { vision: true, toolUse: true });
});
test("a model list is offered as choices for 模型 ID and never presented as a capability claim", async () => {
  let listed: string | undefined;
  globalThis.fetch = withVendorCatalogue(async (request) => {
    if (new URL(request.url).pathname.endsWith("/models/discovery")) {
      listed = new URL(request.url).pathname;
      return Response.json({
        outcome: "ok",
        httpStatus: 200,
        latencyMs: 21,
        message: "服务列出了 2 个模型 ID。",
        models: ["deepseek-chat", "deepseek-reasoner"],
      });
    }
    return Response.json(registered);
  });
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor
          projectId="project"
          model={registered}
          onClose={() => view.unmount()}
          onSaved={() => {}}
        />
      </App>
    </ConfigProvider>,
  );
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://api.deepseek.com/v1" },
  });
  fireEvent.click(screen.getByRole("button", { name: /获取模型列表/ }));
  await screen.findByText("已获取 2 个模型 ID");
  assert.ok(listed?.endsWith("/models/discovery"));
  // The ids become selectable, and the wording states what the list does not prove.
  const modelId = screen.getByLabelText("模型 ID");
  // The field is prefilled with the edited model's own id and acts as a search
  // term, so typing a fragment is how a listed id is reached.
  fireEvent.change(modelId, { target: { value: "deepseek" } });
  fireEvent.focus(modelId);
  fireEvent.mouseDown(modelId);
  assert.ok((await screen.findAllByText("deepseek-reasoner")).length > 0);
  assert.ok(screen.getByText(/不代表模型可用，也不代表具备某种能力/));
  // The field must stay free-text: some services use ids the list never mentions.
  fireEvent.change(modelId, { target: { value: "deepseek-chat-v2" } });
  assert.equal((modelId as HTMLInputElement).value, "deepseek-chat-v2");
});
test("a service without a catalogue endpoint is reported as unsupported, not as a failure", async () => {
  globalThis.fetch = withVendorCatalogue(async () =>
    Response.json({
      outcome: "unsupported",
      httpStatus: 404,
      latencyMs: 8,
      message: "服务未提供模型列表接口，请手动填写模型 ID。",
      models: [],
    }),
  );
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  fill({ baseUrl: "http://model.test/v1", modelId: "qwen3-27b" });
  fireEvent.click(screen.getByRole("button", { name: /获取模型列表/ }));
  await screen.findByText("未能获取模型列表");
  assert.ok(screen.getByText(/请手动填写模型 ID/));
  // The free-text input stays available so the service is still usable.
  assert.ok(screen.getByLabelText("模型 ID"));
});
test("a failed vendor catalogue does not block registering a model", async () => {
  let saved = false,
    catalogueAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/model-vendors")) {
      catalogueAttempts++;
      // The catalogue is unavailable at first and recovers on the retry.
      return catalogueAttempts === 1
        ? Response.json({ message: "目录服务不可用" }, { status: 503 })
        : Response.json(vendorCatalogue);
    }
    saved = true;
    return Response.json(registered);
  };
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  // The failure is stated rather than leaving a silently empty dropdown, and it
  // carries the server's own reason.
  await screen.findByText("供应商列表没有取到");
  assert.ok(screen.getByText("目录服务不可用"));
  // It explicitly says the list is optional, so the operator does not think the
  // model cannot be registered without it.
  assert.ok(screen.getByText(/不影响保存/));
  fireEvent.click(screen.getByRole("button", { name: /重新获取/ }));
  await waitFor(() => assert.equal(catalogueAttempts, 2));
  fill({ baseUrl: "http://model.test/v1", modelId: "qwen3-27b" });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => assert.ok(saved));
});
test("a catalogue route the backend does not serve is not reported as a network outage", async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/model-vendors"))
      // What Hono returns for a route the running control plane does not have.
      return new Response("404 Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    return Response.json([]);
  };
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ModelEditor projectId="project" onClose={() => view.unmount()} onSaved={() => {}} />
      </App>
    </ConfigProvider>,
  );
  await screen.findByText("供应商列表没有取到");
  // Naming the real cause is the point: the operator restarts the backend
  // instead of debugging a network that is fine.
  assert.ok(screen.getByText(/没有这个接口（404）/));
  assert.equal(screen.queryByText(/无法连接平台服务/), null);
});
