import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { StrictMode } from "react";
import { App } from "../../src/app/App.tsx";

afterEach(cleanup);
const user = {
  id: "owner",
  tenantId: "tenant",
  displayName: "Owner",
  kind: "user",
  entry: "console",
};
const projects = ["A", "B"].map((id) => ({
  id,
  tenantId: "tenant",
  name: `项目${id}`,
  description: "",
  createdAt: "2026-09-08T00:00:00Z",
}));
const agent = {
  id: "agent-A",
  projectId: "A",
  name: "A项目助手",
  description: "",
  modelId: "model",
  toolIds: [],
  publishedVersion: 1,
  publishedReleaseId: "release-A",
  draftRevision: 1,
};
function deferred() {
  let complete: (value: Response) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}
function json(value: unknown) {
  return Response.json(value);
}
function fixture(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/auth/status")) return json({ initialized: true });
  if (path === "/api/v1/me") return json(user);
  if (path.endsWith("/auth/login")) return json(user);
  if (path.endsWith("/auth/logout")) return json({ ok: true });
  if (path === "/api/v1/projects") return json(projects);
  if (path === "/api/v1/projects/A/agents") return json([agent]);
  return json([]);
}
function mount(strict = false) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntApp>
        {strict ? (
          <StrictMode>
            <App />
          </StrictMode>
        ) : (
          <App />
        )}
      </AntApp>
    </ConfigProvider>,
  );
}
async function switchProject(name: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "当前项目" }));
  fireEvent.click(await screen.findByText(name, { selector: ".ant-select-item-option-content" }));
  await waitFor(() =>
    assert.ok(document.querySelector(".topbar-project")?.textContent?.includes(name)),
  );
}

test("a conversation created after changing project cannot open in the new project", async (t) => {
  const pending = deferred();
  let started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/projects/A/conversations")) {
      started = request;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getAllByRole("button", { name: /^对话/ }).at(-1) as HTMLElement);
  await waitFor(() => assert.ok(started));
  await switchProject("项目B");
  assert.equal(started?.signal.aborted, true);
  await act(async () =>
    pending.resolve(json({ id: "late-A", projectId: "A", agentId: agent.id, title: "A私有会话" })),
  );
  assert.ok(screen.getByRole("heading", { name: "工作台", level: 1 }));
  assert.equal(screen.queryByText("A私有会话"), null);
  assert.equal(screen.queryByRole("heading", { name: "A项目助手" }), null);
});

test("a failed resource does not block Agents; retry reads only that resource", async (t) => {
  const reads: string[] = [];
  let failModels = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    reads.push(new URL(request.url).pathname);
    if (failModels && request.url.endsWith("/A/models"))
      return Response.json({ message: "模型目录暂不可用" }, { status: 503 });
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  await screen.findByText("模型服务加载失败");
  assert.equal(
    reads.some((path) => /\/applications$|\/conversations$|\/knowledge$/.test(path)),
    false,
  );
  const before = reads.length;
  failModels = false;
  fireEvent.click(screen.getByRole("button", { name: "重试模型服务" }));
  await waitFor(() => assert.ok(screen.queryByText("模型服务加载失败") === null));
  assert.deepEqual(reads.slice(before), ["/api/v1/projects/A/models"]);
  assert.ok(screen.getByRole("heading", { name: "A项目助手" }));
});

test("refresh retains successful application data on failure and deduplicates pending reads", async (t) => {
  const pending = deferred();
  let applicationReads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/A/applications")) {
      applicationReads++;
      return applicationReads === 1
        ? json([{ id: "app-A", name: "订单业务", active: true }])
        : pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getByRole("button", { name: /应用接入/ }));
  await screen.findByText("订单业务");
  fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
  await waitFor(() => assert.equal(applicationReads, 2));
  fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
  await act(async () => pending.resolve(Response.json({ message: "暂不可用" }, { status: 503 })));
  await screen.findByText("应用加载失败");
  assert.equal(applicationReads, 2);
  assert.ok(screen.getByText("订单业务"));
  assert.ok(screen.getByText(/当前显示上次成功加载的数据/));
});

test("project queries are cancelled and cannot repopulate a later cache, including StrictMode", async (t) => {
  const pending = deferred();
  const requests: Request[] = [];
  let latePhase = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (latePhase && request.url.endsWith("/A/agents")) {
      requests.push(request);
      return pending.promise;
    }
    return fixture(request);
  });
  mount(true);
  await waitFor(() => assert.ok(requests.length));
  await switchProject("项目B");
  assert.ok(requests.every((request) => request.signal.aborted));
  await act(async () => pending.resolve(json([{ ...agent, name: "已失效的A项目响应" }])));
  assert.equal(screen.queryByText("已失效的A项目响应"), null);
  latePhase = false;
  await switchProject("项目A");
  await screen.findByRole("heading", { name: "A项目助手" });
  assert.equal(screen.queryByText("已失效的A项目响应"), null);
});

test("revoking an application refreshes only applications", async (t) => {
  const reads: string[] = [];
  let active = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "GET") reads.push(new URL(request.url).pathname);
    if (request.method === "POST" && request.url.includes("/applications/app-A/")) {
      active = false;
      return json({ ok: true });
    }
    if (request.url.endsWith("/A/applications"))
      return json([{ id: "app-A", name: "订单业务", active }]);
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getByRole("button", { name: /应用接入/ }));
  await screen.findByText("订单业务");
  const before = reads.length;
  fireEvent.click(screen.getByRole("button", { name: "撤销凭据" }));
  await screen.findByText("已撤销");
  assert.deepEqual(reads.slice(before), ["/api/v1/projects/A/applications"]);
});

test("Agent editing cannot save an incomplete authorization catalog while it loads", async (t) => {
  const pending = deferred();
  let started = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("/A/knowledge")) {
      started = true;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getByRole("button", { name: /编\s*辑/ }));
  await waitFor(() => assert.ok(started));
  const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  await act(async () => pending.resolve(json([])));
  await waitFor(() => assert.equal(save.disabled, false));
});

test("an application credential response cannot reopen a closed editor in another project", async (t) => {
  const pending = deferred();
  let started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/projects/A/applications")) {
      started = request;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getByRole("button", { name: /应用接入/ }));
  fireEvent.click(screen.getByRole("button", { name: /创建应用/ }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "A应用" } });
  fireEvent.submit(screen.getByLabelText("名称").closest("form") as HTMLFormElement);
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: /关闭|Close/ }));
  await switchProject("项目B");
  assert.equal(started?.signal.aborted, true);
  await act(async () =>
    pending.resolve(json({ id: "app-A", accessKey: "ak-A", secretKey: "must-not-appear-in-B" })),
  );
  assert.equal(screen.queryByText("保存应用凭据"), null);
  assert.equal(document.querySelector('input[value="must-not-appear-in-B"]'), null);
});

test("logout unmounts project requests and logging in starts a clean workspace", async (t) => {
  const pending = deferred();
  let started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/projects/A/conversations")) {
      started = request;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getAllByRole("button", { name: /^对话/ }).at(-1) as HTMLElement);
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "登录工作空间" });
  assert.equal(started?.signal.aborted, true);
  await act(async () =>
    pending.resolve(
      json({ id: "late-A", projectId: "A", agentId: agent.id, title: "上一会话内容" }),
    ),
  );
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "test-password-123" } });
  fireEvent.submit(screen.getByLabelText("账号").closest("form") as HTMLFormElement);
  await screen.findByRole("heading", { name: "A项目助手" });
  assert.ok(screen.getByRole("heading", { name: "工作台", level: 1 }));
  assert.equal(screen.queryByText("上一会话内容"), null);
});

test("leaving the Agent page cancels conversation creation even within the same project", async (t) => {
  const pending = deferred();
  let started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/A/conversations")) {
      started = request;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getAllByRole("button", { name: /^对话/ }).at(-1) as HTMLElement);
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: /^工具$/ }));
  await screen.findByRole("heading", { name: "工具", level: 1 });
  assert.equal(started?.signal.aborted, true);
  await act(async () => pending.resolve(json({ id: "late", projectId: "A", title: "迟到的会话" })));
  assert.ok(screen.getByRole("heading", { name: "工具", level: 1 }));
  assert.ok(screen.queryByText("迟到的会话") === null);
});

test("conversation history errors are local and leaving the page cancels retry", async (t) => {
  const pending = deferred();
  let reads = 0,
    started: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/A/conversations"))
      return json([
        {
          id: "thread",
          projectId: "A",
          title: "订单讨论",
          releaseVersion: 1,
          createdAt: "2026-09-08T00:00:00Z",
        },
      ]);
    if (request.url.endsWith("/thread/messages")) {
      if (++reads === 1) return Response.json({ message: "历史读取失败" }, { status: 503 });
      started = request;
      return pending.promise;
    }
    return fixture(request);
  });
  mount();
  await screen.findByRole("heading", { name: "A项目助手" });
  fireEvent.click(screen.getAllByRole("button", { name: /^对话/ })[0]);
  fireEvent.click(await screen.findByRole("button", { name: /订单讨论/ }));
  await screen.findByText("会话历史加载失败");
  fireEvent.click(screen.getByRole("button", { name: "重试会话历史" }));
  await waitFor(() => assert.ok(started));
  fireEvent.click(screen.getByRole("button", { name: /^工具$/ }));
  assert.equal(started?.signal.aborted, true);
  await act(async () =>
    pending.resolve(
      json([{ id: "old", role: "assistant", parts: [{ type: "text", text: "已关闭会话的正文" }] }]),
    ),
  );
  assert.ok(screen.queryByText("已关闭会话的正文") === null);
});
