import { afterEach } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { consoleRoutes } from "../../src/app/routing/routes";

const routers: ReturnType<typeof createMemoryRouter>[] = [];
afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
});
export function mountConsole({
  strict = false,
  initialEntries = ["/"],
}: {
  strict?: boolean;
  initialEntries?: string[];
} = {}) {
  const router = createMemoryRouter(consoleRoutes, { initialEntries });
  routers.push(router);
  const app = <RouterProvider router={router} />;
  const view = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AntApp>{strict ? <StrictMode>{app}</StrictMode> : app}</AntApp>
    </ConfigProvider>,
  );
  return { ...view, router };
}
