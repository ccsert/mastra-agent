import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Tool } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { ToolEditor, ToolWorkspace } from "../../src/features/tools/index.ts";
import { ProjectAccessContext } from "../../src/shared/access.ts";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
const registered: Tool = {
  id: "tool-1",
  projectId: "project",
  name: "order_lookup",
  description: "读取订单",
  kind: "http_get",
  url: "http://tool.test/orders",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  outputSchema: { type: "object" },
  hasCredential: true,
  createdAt: "2026-09-11",
  version: 1,
};
const mount = (tool?: Tool) => (
  <ConfigProvider theme={{ token: { motion: false } }}>
    <App>
      <ToolEditor projectId="project" tool={tool} onClose={() => {}} onSaved={() => {}} />
    </App>
  </ConfigProvider>
);
/**
 * A new tool starts as the built-in sum, so the HTTP-only fields need the kind
 * switched first. Labels are matched loosely because antd appends `(optional)`
 * to a field without a required rule.
 */
const label = (text: string) => screen.getByLabelText(new RegExp(text));
async function chooseHttpGet() {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: /执行方式/ }));
  fireEvent.click(await screen.findByText("HTTP GET · 只读 JSON 接口"));
  await screen.findByLabelText(/接口地址/);
}
test("editing prefills the tool, sends a PATCH and keeps the stored token when it is left blank", async () => {
  let method: string | undefined,
    url: string | undefined,
    body: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    method = request.method;
    url = request.url;
    body = (await request.json()) as Record<string, unknown>;
    return Response.json(registered);
  };
  render(mount(registered));
  assert.equal((label("工具调用名") as HTMLInputElement).value, "order_lookup");
  assert.equal((label("接口地址") as HTMLInputElement).value, "http://tool.test/orders");
  fireEvent.change(label("说明"), { target: { value: "读取订单与明细" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => assert.ok(body));
  assert.equal(method, "PATCH");
  assert.ok(url?.endsWith("/api/v1/projects/project/tools/tool-1"), url);
  assert.equal(body?.description, "读取订单与明细");
  assert.equal("bearerToken" in (body ?? {}), false, "a blank token keeps the stored credential");
});
test("the editor calls the tool before saving and shows the request that was made", async () => {
  let probed: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    if (new URL(request.url).pathname.endsWith("/tools/probe")) {
      probed = body;
      return Response.json({
        outcome: "mismatch",
        httpStatus: 200,
        latencyMs: 23,
        message: "服务返回了 JSON，但不符合声明的输出 schema。",
        requestUrl: "http://tool.test/orders?id=A-1",
        preview: '["not-an-object"]',
      });
    }
    return Response.json(registered);
  };
  render(mount());
  fireEvent.change(label("工具调用名"), { target: { value: "order_lookup" } });
  fireEvent.change(label("说明"), { target: { value: "读取订单" } });
  await chooseHttpGet();
  fireEvent.change(label("接口地址"), { target: { value: "http://tool.test/orders" } });
  fireEvent.change(label("样例参数"), { target: { value: '{"id":"A-1"}' } });
  fireEvent.click(screen.getByRole("button", { name: /测试调用/ }));
  await screen.findByText("服务返回了 JSON，但不符合声明的输出 schema");
  // The exact request is shown, so an operator can see how arguments are encoded.
  assert.ok(screen.getByText("http://tool.test/orders?id=A-1"));
  assert.ok(screen.getByText(/需要修正的是上面填写的输出 JSON Schema/));
  assert.equal(probed?.kind, "http_get");
  assert.deepEqual(probed?.input, { id: "A-1" });
});
test("the sum tool is verified without any request and never claims one was made", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(new URL(request.url).pathname);
    return Response.json({
      outcome: "ok",
      httpStatus: null,
      latencyMs: null,
      message: "求和结果为 120。",
      requestUrl: null,
      preview: '{"total":120}',
    });
  };
  render(mount());
  fireEvent.change(label("工具调用名"), { target: { value: "sum_values" } });
  fireEvent.change(label("说明"), { target: { value: "求和" } });
  fireEvent.change(label("样例参数"), { target: { value: '{"values":[40,80]}' } });
  fireEvent.click(screen.getByRole("button", { name: /测试调用/ }));
  await screen.findByText("调用成功，返回符合声明的输出 schema");
  // The computed result is stated in words; the raw payload is shown beside it.
  assert.ok(screen.getByText("求和结果为 120。"));
  assert.equal(calls.filter((p) => p.endsWith("/tools/probe")).length, 1);
  // `sum` has no address, so the editor must not claim one was called.
  assert.equal(screen.queryByText(/实际请求/), null);
});
test("an unreachable service is reported as the platform's own network, not a tool verdict", async () => {
  globalThis.fetch = async () =>
    Response.json({
      outcome: "unreachable",
      httpStatus: null,
      latencyMs: 9,
      message: "平台无法连接该地址（ECONNREFUSED）。",
      requestUrl: "http://tool.test/orders",
      preview: null,
    });
  render(mount());
  fireEvent.change(label("工具调用名"), { target: { value: "order_lookup" } });
  fireEvent.change(label("说明"), { target: { value: "读取订单" } });
  await chooseHttpGet();
  fireEvent.change(label("接口地址"), { target: { value: "http://tool.test/orders" } });
  fireEvent.click(screen.getByRole("button", { name: /测试调用/ }));
  await screen.findByText("平台无法连接该地址");
  assert.ok(screen.getByText(/不要据此判断接口配置有误/));
});
test("a schema that is not JSON is rejected locally, before any request is sent", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(new URL((input as Request).url).pathname);
    return Response.json(registered);
  };
  render(mount());
  fireEvent.change(label("工具调用名"), { target: { value: "order_lookup" } });
  fireEvent.change(label("说明"), { target: { value: "读取订单" } });
  await chooseHttpGet();
  fireEvent.change(label("接口地址"), { target: { value: "http://tool.test/orders" } });
  fireEvent.change(label("输出 JSON Schema"), { target: { value: "{not json" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await screen.findByText("输出 schema 不是合法的 JSON");
  assert.deepEqual(calls, [], "no request is sent for an invalid schema");
});
test("the tool list offers edit only for authored tools and says why MCP ones cannot be", async () => {
  const imported: Tool = {
    ...registered,
    id: "tool-mcp",
    name: "mcp_fixture",
    kind: "mcp",
    mcp: {
      serverId: "server",
      contractDigest: "digest",
      descriptor: { name: "remote_sum", inputSchema: { type: "object" } },
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL((input as Request).url);
    if (url.pathname.endsWith("/tools")) return Response.json([registered, imported]);
    return Response.json([]);
  };
  const edits: string[] = [];
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="project">
          <ProjectAccessContext.Provider
            value={{
              projectId: "project",
              role: "admin",
              tenantRole: "owner",
              permissions: ["resource.read", "resource.manage"],
            }}
          >
            <ToolWorkspace onCreate={() => {}} onEdit={(t) => edits.push(t.id)} />
          </ProjectAccessContext.Provider>
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
  // Only the hand-authored tool has an edit action.
  const edit = await screen.findByRole("button", { name: /编\s*辑/ });
  fireEvent.click(edit);
  assert.deepEqual(edits, ["tool-1"]);
  assert.equal(screen.queryAllByRole("button", { name: /编\s*辑/ }).length, 1);
  // The imported tool states why it is not editable rather than looking broken.
  assert.ok(screen.getByText("不可编辑"));
});
