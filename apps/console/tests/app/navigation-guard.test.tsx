import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, Button, ConfigProvider } from "antd";
import { useEffect, useRef } from "react";
import { createMemoryRouter, Link, Outlet, RouterProvider, useLocation } from "react-router";
import { useNavigationGuard } from "../../src/app/routing/NavigationGuard.tsx";
import { loginDestination } from "../../src/shared/navigation.ts";

afterEach(cleanup);
test("navigation guards handle PUSH, POP, busy state, reload and confirmed exit without duplicate prompts", async (t) => {
  let exits = 0;
  function Shell() {
    const { registerGuard, confirmExit } = useNavigationGuard();
    const location = useLocation();
    const reason = useRef<"dirty" | "busy" | null>(null);
    useEffect(() => {
      registerGuard(() => (location.pathname === "/edit" ? reason.current : null));
      return () => registerGuard();
    }, [registerGuard, location.pathname]);
    return (
      <>
        <Link to="/list">列表</Link>
        <Button
          onClick={() => {
            reason.current = "dirty";
          }}
        >
          修改草稿
        </Button>
        <Button
          onClick={() => {
            reason.current = "busy";
          }}
        >
          开始提交
        </Button>
        <Button
          onClick={() =>
            void confirmExit(async () => {
              exits++;
            })
          }
        >
          退出
        </Button>
        <Outlet />
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        Component: Shell,
        children: [
          { path: "list", element: <h1>流程列表</h1> },
          { path: "edit", element: <h1>编辑草稿</h1> },
        ],
      },
    ],
    { initialEntries: ["/list", "/edit"] },
  );
  t.after(() => router.dispose());
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <RouterProvider router={router} />
      </App>
    </ConfigProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "开始提交" }));
  fireEvent.click(screen.getByRole("link", { name: "列表" }));
  await screen.findByText("请等待当前工作流操作完成");
  assert.equal(router.state.location.pathname, "/edit");
  assert.equal(screen.queryByRole("dialog", { name: "离开未保存的草稿？" }), null);
  fireEvent.click(screen.getByRole("button", { name: "修改草稿" }));
  const unload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  fireEvent.click(screen.getByRole("link", { name: "列表" }));
  await screen.findByRole("dialog", { name: "离开未保存的草稿？" });
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("dialog", { name: "离开未保存的草稿？" }), null),
  );
  assert.equal(router.state.location.pathname, "/edit");
  await act(() => router.navigate(-1));
  await screen.findByRole("dialog", { name: "离开未保存的草稿？" });
  assert.equal(screen.getAllByRole("dialog", { name: "离开未保存的草稿？" }).length, 1);
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => assert.equal(router.state.blockers.size, 1));
  await act(() => router.navigate(-1));
  await screen.findByRole("dialog", { name: "离开未保存的草稿？" });
  fireEvent.click(screen.getByRole("button", { name: /^离\s*开$/ }));
  await screen.findByRole("heading", { name: "流程列表" });
  assert.equal(router.state.location.pathname, "/list");
  await act(() => router.navigate(1));
  await screen.findByRole("heading", { name: "编辑草稿" });
  fireEvent.click(screen.getByRole("button", { name: /^退\s*出$/ }));
  await screen.findByRole("dialog", { name: "离开未保存的草稿？" });
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("dialog", { name: "离开未保存的草稿？" }), null),
  );
  assert.equal(exits, 0);
  fireEvent.click(screen.getByRole("button", { name: /^退\s*出$/ }));
  await screen.findByRole("dialog", { name: "离开未保存的草稿？" });
  fireEvent.click(screen.getByRole("button", { name: /^离\s*开$/ }));
  await waitFor(() => assert.equal(exits, 1));
});

test("login return targets cannot redirect to another origin", () => {
  for (const target of [
    "https://outside.invalid",
    "//outside.invalid",
    "/\\outside.invalid",
    "/login",
    "/\n/outside.invalid",
  ]) {
    assert.equal(loginDestination(`?${new URLSearchParams({ returnTo: target })}`), "/");
  }
  const target = "/projects/p/chat/c?filter=a%20b#message";
  assert.equal(loginDestination(`?${new URLSearchParams({ returnTo: target })}`), target);
});
