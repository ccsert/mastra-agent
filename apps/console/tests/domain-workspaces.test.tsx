import "./dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { KnowledgeBase, KnowledgeDocument, WorkflowRelease } from "@platform/sdk";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { ProjectData } from "../src/data/ProjectData";
import { KnowledgeWorkspace } from "../src/Knowledge";
import { McpWorkspace } from "../src/Mcp";
import { emptyWorkflow } from "../src/workflow-model";
import { WorkflowRunDetails } from "../src/workflows/WorkflowRunDetails";
import { WorkflowRunDialog } from "../src/workflows/WorkflowRunDialog";

afterEach(cleanup);
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function mount(children: ReactNode) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntApp>
        <ProjectData projectId="A">{children}</ProjectData>
      </AntApp>
    </ConfigProvider>,
  );
}
const bases: KnowledgeBase[] = ["第一知识库", "第二知识库"].map((name, index) => ({
  id: `kb-${index}`,
  projectId: "A",
  name,
  description: "",
  embeddingModelId: "model",
  rerankModelId: null,
  chunkSize: 800,
  chunkOverlap: 80,
  dimensions: 1024,
  documentCount: 1,
  readyCount: 1,
  chunkCount: 1,
  createdAt: "2026-09-08T00:00:00Z",
}));
function document(kbId: string, filename: string): KnowledgeDocument {
  return {
    id: `doc-${kbId}`,
    knowledgeBaseId: kbId,
    filename,
    contentHash: "hash",
    status: "ready",
    chunkCount: 1,
    errorCode: null,
    createdAt: "2026-09-08T00:00:00Z",
  };
}

test("switching knowledge bases cancels the old document query and never restores its late response", async (t) => {
  const pending = deferred();
  let oldRequest: Request | undefined,
    reads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/knowledge")) return Response.json(bases);
    if (request.url.endsWith("/kb-0/documents")) {
      if (++reads === 1) {
        oldRequest = request;
        return pending.promise;
      }
      return Response.json([document("kb-0", "当前第一资料.md")]);
    }
    return Response.json([document("kb-1", "第二资料.md")]);
  });
  mount(<KnowledgeWorkspace projectId="A" models={[]} onConfigureModels={() => {}} />);
  await waitFor(() => assert.ok(oldRequest));
  fireEvent.click(screen.getByRole("button", { name: /第二知识库/ }));
  await screen.findByText("第二资料.md");
  assert.equal(oldRequest?.signal.aborted, true);
  await act(async () => pending.resolve(Response.json([document("kb-0", "过期第一资料.md")])));
  assert.ok(screen.queryByText("过期第一资料.md") === null);
  fireEvent.click(screen.getByRole("button", { name: /第一知识库/ }));
  await screen.findByText("当前第一资料.md");
  assert.ok(screen.queryByText("过期第一资料.md") === null);
});

test("closing a document preview cancels its plaintext request", async (t) => {
  const pending = deferred();
  let started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/knowledge")) return Response.json([bases[0]]);
    if (request.url.endsWith("/documents")) return Response.json([document("kb-0", "资料.md")]);
    started = request;
    return pending.promise;
  });
  mount(<KnowledgeWorkspace projectId="A" models={[]} onConfigureModels={() => {}} />);
  await screen.findByText("资料.md");
  fireEvent.click(screen.getByRole("button", { name: "查看分段" }));
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
  assert.equal(started?.signal.aborted, true);
  await act(async () =>
    pending.resolve(
      Response.json([{ id: "chunk", ordinal: 0, content: "迟到的私有正文", contentHash: "hash" }]),
    ),
  );
  assert.ok(screen.queryByText("迟到的私有正文") === null);
});

test("MCP has a retryable directory error and closing service details cancels discovery reads", async (t) => {
  const pending = deferred();
  let fail = true,
    started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/tools")) return Response.json([]);
    if (request.url.endsWith("/mcp-servers"))
      return fail
        ? Response.json({ message: "目录暂不可用" }, { status: 503 })
        : Response.json([
            {
              id: "mcp",
              projectId: "A",
              name: "订单服务",
              url: "http://mcp.test",
              enabled: true,
              hasCredential: true,
            },
          ]);
    started = request;
    return pending.promise;
  });
  mount(<McpWorkspace projectId="A" />);
  await screen.findByText("MCP 服务加载失败");
  assert.ok(screen.queryByText(/还没有 MCP 服务/) === null);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试MCP 服务" }));
  await screen.findByText("订单服务");
  fireEvent.click(screen.getByRole("button", { name: "管理能力" }));
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
  await waitFor(() => assert.equal(started?.signal.aborted, true));
  await act(async () => pending.resolve(Response.json([])));
  assert.ok(screen.queryByRole("button", { name: "发现能力" }) === null);
});

test("workflow node errors leave run results visible and retry only the node query", async (t) => {
  let fail = true;
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname;
    reads.push(path);
    if (path.endsWith("/nodes"))
      return fail ? Response.json({ message: "节点目录失败" }, { status: 503 }) : Response.json([]);
    return Response.json({
      id: "run",
      name: "历史订单报告",
      version: 2,
      status: "succeeded",
      createdAt: "2026-09-08T00:00:00Z",
      output: { report: "报告正文" },
    });
  });
  mount(<WorkflowRunDetails projectId="A" workflowId="workflow" id="run" onClose={() => {}} />);
  await screen.findByText("节点执行记录加载失败");
  assert.ok(screen.getByText("报告正文"));
  const before = reads.length;
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试节点执行记录" }));
  await waitFor(() => assert.ok(screen.queryByText("节点执行记录加载失败") === null));
  assert.deepEqual(reads.slice(before), ["/api/v1/projects/A/workflow-runs/run/nodes"]);
});

test("a closed workflow run dialog suppresses late completion and duplicate submissions", async (t) => {
  const pending = deferred();
  let started: Request | undefined,
    calls = 0,
    completed = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    started = new Request(input, init);
    calls++;
    return pending.promise;
  });
  const release: WorkflowRelease = {
    id: "release",
    workflowId: "workflow",
    projectId: "A",
    name: "报告",
    version: 1,
    digest: "digest",
    createdAt: "2026-09-08T00:00:00Z",
    snapshot: {
      definition: emptyWorkflow("报告").definition,
      tools: [],
      agents: [],
      catalog: [],
      adapterVersion: "mastra-workflow-v1",
    },
  };
  const view = mount(
    <WorkflowRunDialog
      projectId="A"
      workflowId="workflow"
      initialRelease={release}
      releases={[release]}
      onClose={() => {}}
      onStarted={() => completed++}
    />,
  );
  const submit = screen.getByRole("button", { name: "开始执行" });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => assert.ok(started));
  assert.equal(calls, 1);
  view.unmount();
  assert.equal(started?.signal.aborted, true);
  await act(async () => pending.resolve(Response.json({ id: "late-run" })));
  assert.equal(completed, 0);
});

test("MCP credential failures remain visible inside the owning dialog", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "PATCH")
      return Response.json({ message: "凭据保存失败" }, { status: 503 });
    if (request.url.endsWith("/mcp-servers"))
      return Response.json([
        {
          id: "mcp",
          projectId: "A",
          name: "订单服务",
          url: "http://mcp.test",
          enabled: true,
          hasCredential: true,
        },
      ]);
    return Response.json([]);
  });
  mount(<McpWorkspace projectId="A" />);
  fireEvent.click(await screen.findByRole("button", { name: "管理能力" }));
  fireEvent.click(await screen.findByRole("button", { name: /更新凭据/ }));
  const dialog = screen.getByRole("dialog", { name: "更新 MCP 凭据" });
  fireEvent.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
  assert.ok(await within(dialog).findByText("凭据保存失败"));
});
