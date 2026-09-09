import type { RouteObject } from "react-router";
import { pages } from "../../shared/navigation";
import { App } from "../App";
import { ProjectPage } from "./ProjectPage";

const detailPages = new Set(["chat", "workflows", "knowledge", "skills", "mcp", "runs"]);
/** The production browser and integration tests use the same explicit route tree. */
export const consoleRoutes: RouteObject[] = [
  {
    Component: App,
    children: [
      { index: true, element: <></> },
      { path: "login", element: <></> },
      {
        path: "projects/:projectId",
        children: [
          { index: true, element: <></> },
          ...pages.map((page) => ({
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
