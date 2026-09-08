import "./dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { App } from "../src/App.tsx";

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
function mount() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntApp>
        <App />
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
