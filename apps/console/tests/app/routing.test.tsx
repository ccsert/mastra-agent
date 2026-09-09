import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { pages, projectPath } from "../../src/shared/navigation.ts";
import { mountConsole } from "../helpers/console.tsx";

const user = {
  id: "owner",
  tenantId: "tenant",
  displayName: "Owner",
  kind: "user",
  entry: "console",
};
const projects = ["A", "B"].map((id) => ({
  id,
  name: `项目${id}`,
  tenantId: "tenant",
  description: "",
}));
function fixture(req: Request) {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/auth/status")) return Response.json({ initialized: true });
  if (path.endsWith("/me") || path.endsWith("/auth/login")) return Response.json(user);
  if (path === "/api/v1/projects") return Response.json(projects);
  return Response.json([]);
}

test("project URLs drive the page, link destinations, reload and browser history", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(new URL(req.url).pathname);
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/B/tools"] });
  await screen.findByRole("heading", { name: "工具", level: 1 });
  assert.ok(document.title.includes("项目B"));
  assert.equal(
    requests.some((p) => p.startsWith("/api/v1/projects/A/")),
    false,
  );
  const links = [...document.querySelectorAll<HTMLAnchorElement>("nav a")];
  assert.deepEqual(
    links.map((a) => a.getAttribute("href")),
    pages.map((p) => projectPath("B", p)),
  );
  fireEvent.click(screen.getByRole("link", { name: "模型服务" }));
  await screen.findByRole("heading", { name: "模型服务", level: 1 });
  assert.equal(view.router.state.location.pathname, "/projects/B/models");
  await act(() => view.router.navigate(-1));
  await screen.findByRole("heading", { name: "工具", level: 1 });
  await act(() => view.router.navigate(1));
  await screen.findByRole("heading", { name: "模型服务", level: 1 });
  const address = view.router.state.location.pathname;
  view.unmount();
  view.router.dispose();
  mountConsole({ initialEntries: [address] });
  await screen.findByRole("heading", { name: "模型服务", level: 1 });
  assert.ok(document.querySelector(".topbar-project")?.textContent?.includes("项目B"));
});

test("POP project changes cancel the previous project's request and ignore its late result", async (t) => {
  let pending: Request | undefined, finish: ((r: Response) => void) | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/B/tools")) {
      pending = req;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/A/agents", "/projects/B/tools"] });
  await waitFor(() => assert.ok(pending));
  await act(() => view.router.navigate(-1));
  await screen.findByRole("heading", { name: "Agents", level: 1 });
  assert.ok(pending?.signal.aborted);
  await act(async () => finish?.(Response.json([{ id: "late", name: "B迟到工具", kind: "sum" }])));
  assert.equal(screen.queryByText("B迟到工具"), null);
  assert.equal(view.router.state.location.pathname, "/projects/A/agents");
});

for (const [path, title] of [
  ["/projects/forbidden/tools", "项目不存在或无权访问"],
  ["/projects/A/unknown", "页面不存在"],
  ["/not-a-page", "页面不存在"],
]) {
  test(`unknown route ${path} never silently chooses a project or reads its resources`, async (t) => {
    const reads: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      reads.push(new URL(req.url).pathname);
      return fixture(req);
    });
    const view = mountConsole({ initialEntries: [path] });
    await screen.findByText(title);
    assert.equal(view.router.state.location.pathname, path);
    assert.equal(
      reads.some((p) => p.startsWith("/api/v1/projects/")),
      false,
    );
  });
}

test("sign-in returns to a deep conversation URL and loads its metadata independently of list pagination", async (t) => {
  let signedIn = false;
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    reads.push(path);
    if (path.endsWith("/me") && !signedIn)
      return Response.json({ message: "请登录" }, { status: 401 });
    if (path.endsWith("/auth/login")) signedIn = true;
    if (path.endsWith("/conversations/old"))
      return Response.json({ id: "old", title: "更早的对话", releaseVersion: 2 });
    if (path.endsWith("/old/messages"))
      return Response.json({ message: "合成历史暂不可用" }, { status: 503 });
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/B/chat/old"] });
  await screen.findByRole("heading", { name: "登录工作空间" });
  await waitFor(() => assert.equal(view.router.state.location.pathname, "/login"));
  assert.equal(
    new URLSearchParams(view.router.state.location.search).get("returnTo"),
    "/projects/B/chat/old",
  );
  assert.equal(reads.includes("/api/v1/projects"), false);
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "test-password-123" } });
  const form = screen.getByLabelText("账号").closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  await screen.findByText("更早的对话");
  assert.equal(view.router.state.location.pathname, "/projects/B/chat/old");
  assert.ok(reads.includes("/api/v1/projects/B/conversations/old"));
  await screen.findByText("会话历史加载失败");
});

test("detail routes expose missing resources and loading failures instead of silently selecting another resource", async (t) => {
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    reads.push(path);
    if (path.endsWith("/conversations/missing"))
      return Response.json({ message: "资源不存在" }, { status: 404 });
    if (path.endsWith("/knowledge"))
      return Response.json([{ id: "first", name: "不应自动选择的知识库" }]);
    if (path.endsWith("/mcp-servers"))
      return Response.json({ message: "MCP 目录暂不可用" }, { status: 503 });
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/A/chat/missing"] });
  await screen.findByText("会话信息加载失败");
  assert.equal(
    reads.some((p) => p.endsWith("/messages")),
    false,
  );
  await act(() => view.router.navigate("/projects/A/knowledge/missing"));
  await screen.findByText("知识库不存在或无权访问");
  assert.equal(
    reads.some((p) => p.includes("/first/documents")),
    false,
  );
  assert.equal(view.router.state.location.pathname, "/projects/A/knowledge/missing");
  await act(() => view.router.navigate("/projects/A/mcp/example"));
  const dialog = await screen.findByRole("dialog", { name: "MCP 服务" });
  assert.ok(await within(dialog).findByRole("button", { name: "重试MCP 服务信息" }));
});

test("an old Skill URL opens without loading earlier pages and closing it cancels file content", async (t) => {
  let file: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    if (path.endsWith("/skills/old"))
      return Response.json({
        id: "old",
        name: "old-skill",
        description: "旧技能版本",
        version: 1,
        enabled: true,
        files: [{ path: "SKILL.md" }],
        entrypoints: [],
        warnings: [],
        digest: "hash",
      });
    if (path.endsWith("/old/file")) {
      file = req;
      return new Promise<Response>((_resolve, reject) =>
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/A/skills/old"] });
  await waitFor(() => assert.ok(file));
  assert.ok(screen.getByText("旧技能版本"));
  fireEvent.click(screen.getByRole("button", { name: /Close|关闭/ }));
  await waitFor(() => assert.equal(view.router.state.location.pathname, "/projects/A/skills"));
  await waitFor(() => assert.ok(file?.signal.aborted));
});

test("run deep links load their own details and closing them cancels pending events", async (t) => {
  let events: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      path = new URL(req.url).pathname;
    if (path.endsWith("/runs/old"))
      return Response.json({
        id: "old",
        agentName: "历史助手",
        status: "succeeded",
        releaseVersion: 1,
        runtimeId: "fixture",
        createdAt: "2026-01-01",
        outputText: "保留的报告",
      });
    if (path.endsWith("/old/events")) {
      events = req;
      return new Promise<Response>((_resolve, reject) =>
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }
    return fixture(req);
  });
  const view = mountConsole({ initialEntries: ["/projects/A/runs/old"] });
  await screen.findByText("保留的报告");
  await waitFor(() => assert.ok(events));
  fireEvent.click(screen.getByRole("button", { name: /Close|关闭/ }));
  await waitFor(() => assert.equal(view.router.state.location.pathname, "/projects/A/runs"));
  await waitFor(() => assert.ok(events?.signal.aborted));
});
