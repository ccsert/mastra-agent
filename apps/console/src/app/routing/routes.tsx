import type { RouteObject } from "react-router";
import { pages } from "../../shared/navigation";
import { App } from "../App";
import { ProjectPage } from "./ProjectPage";

const detailPages = new Set(["agents", "chat", "workflows", "knowledge", "skills", "mcp", "runs"]);
/** The production browser and integration tests use the same explicit route tree. */
export const consoleRoutes: RouteObject[] = [
  {
    Component: App,
    children: [
      { index: true, element: <></> },
      { path: "login", element: <></> },
      { path: "join", element: <></> },
      { path: "team", handle: { page: "team" }, Component: ProjectPage },
      {
        path: "projects/:projectId",
        children: [
          { index: true, element: <></> },
          ...pages
            .filter((page) => page !== "team")
            .map((page) => ({
              path: `${page}${detailPages.has(page) ? "/:resourceId?" : ""}`,
              handle: { page },
              Component: ProjectPage,
            })),
        ],
      },
      { path: "*", element: <></> },
    ],
  },
];
