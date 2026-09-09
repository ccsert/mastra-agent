import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ProjectData, useProjectPages, useProjectRefresh } from "../../src/shared/data/ProjectData";
import { PageMore, pageItems } from "../../src/shared/data/pages";
import { QueryState } from "../../src/shared/data/QueryState";

afterEach(cleanup);
function List() {
  const query = useProjectPages("workflows"),
    items = pageItems(query.data),
    refresh = useProjectRefresh();
  return (
    <>
      <button type="button" onClick={() => void refresh("workflows")}>
        刷新
      </button>
      <QueryState query={query} label="工作流">
        {items.map((item) => (
          <p key={item.id}>{item.name}</p>
        ))}
        <PageMore query={query} count={items.length} label="工作流" />
      </QueryState>
    </>
  );
}
function mount(projectId: string) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntApp>
        <ProjectData key={projectId} projectId={projectId}>
          <List />
        </ProjectData>
      </AntApp>
    </ConfigProvider>
  );
}
test("pages use the server cursor, keep data on failure, retry and cancel at the project boundary", async (t) => {
  let fail = true,
    refreshed = false,
    pending: Request | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url),
      cursor = url.searchParams.get("cursor");
    if (url.pathname.includes("/B/")) return Response.json([]);
    if (cursor === "tail") {
      pending = request;
      return new Promise<Response>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }
    if (cursor) {
      assert.equal(cursor, refreshed ? "new-position" : "position");
      if (fail) return Response.json({ message: "合成网络故障" }, { status: 503 });
      return Response.json([{ id: "second", name: "第二条" }], {
        headers: { "X-Next-Cursor": "tail" },
      });
    }
    return Response.json([{ id: "first", name: refreshed ? "刷新后的第一条" : "第一条" }], {
      headers: { "X-Next-Cursor": refreshed ? "new-position" : "position" },
    });
  });
  const view = render(mount("A"));
  await screen.findByText("第一条");
  fireEvent.click(screen.getByRole("button", { name: "加载更多工作流" }));
  await screen.findByText("工作流加载失败");
  assert.ok(screen.getByText("第一条"));
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试加载更多工作流" }));
  await screen.findByText("第二条");
  refreshed = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText("刷新后的第一条");
  assert.equal(screen.getAllByText("第二条").length, 1);
  fireEvent.click(screen.getByRole("button", { name: "加载更多工作流" }));
  await waitFor(() => assert.ok(pending));
  view.rerender(mount("B"));
  await waitFor(() => assert.equal(pending?.signal.aborted, true));
  assert.equal(screen.queryByText("第二条"), null);
});
