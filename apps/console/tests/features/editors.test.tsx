import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Agent } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { AgentEditor } from "../../src/features/agents/index.ts";
import { ModelEditor } from "../../src/features/models/index.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
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
  await screen.findByText("Skill 目录读取失败");
  const save = screen.getByRole("button", { name: "保存草稿" });
  assert.ok(save.hasAttribute("disabled"));
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));
  await waitFor(() => assert.ok(!save.hasAttribute("disabled")));
  fireEvent.click(save);
  await waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(saved?.skillBindings, agent.skillBindings);
  assert.equal(saved?.baseRevision, 7);
  assert.equal(saved?.modelId, "model");
});
test("model editor retains configurable embedding dimensions and cancels a pending submission on close", async () => {
  let body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    late: ((r: Response) => void) | undefined,
    saved = 0;
  globalThis.fetch = async (input) => {
    const req = input as Request;
    body = await req.json();
    signal = req.signal;
    return new Promise((resolve) => {
      late = resolve;
    });
  };
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
