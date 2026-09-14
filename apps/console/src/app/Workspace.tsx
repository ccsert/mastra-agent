import type { Project } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Spin } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useMatch, useMatches, useNavigate } from "react-router";
import { unwrap } from "../shared/api";
import { ProjectData } from "../shared/data/ProjectData";
import { type Page, pages, projectPath } from "../shared/navigation";
import { useLifetime } from "../shared/useLifetime";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { ProjectConsole } from "./ProjectConsole";
import { RouteMissing } from "./routing/RouteMissing";

export function Workspace(session: ConsoleSession) {
  const lifetime = useLifetime();
  const navigate = useNavigate();
  const location = useLocation();
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectId = projectMatch?.params.projectId ?? "";
  const page = useMatches()
    .map((m) => (m.handle as { page?: Page } | undefined)?.page)
    .find((p) => p && pages.includes(p));
  const [projects, setProjects] = useState<Project[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const request = useRef(0);
  const refreshProjects = useCallback(
    async (chooseNewest = false) => {
      const signal = lifetime(),
        current = ++request.current;
      try {
        const items = await unwrap(api.listProjects({ signal }));
        if (signal.aborted || current !== request.current) return;
        setProjects(items);
        const newest = items.at(-1);
        if (chooseNewest && newest) void navigate(projectPath(newest.id));
        setError("");
        setReady(true);
      } catch (error) {
        if (!signal.aborted && current === request.current)
          setError(error instanceof Error ? error.message : "无法读取项目");
      }
    },
    [lifetime, navigate],
  );
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);
  const defaultProject = projects[0];
  const landing = location.pathname === "/" || location.pathname === "/login";
  const shell = (id: string, currentPage: Page) => (
    <ProjectData key={id} projectId={id} owner={`${session.user.tenantId}:${session.user.id}`}>
      <ProjectConsole
        {...session}
        projects={projects}
        projectId={id}
        page={currentPage}
        onProjectChange={(next) => void navigate(projectPath(next))}
        refreshProjects={refreshProjects}
      />
    </ProjectData>
  );
  function content() {
    if (!ready)
      return (
        !error && (
          <div className="full-loader">
            <Spin description="加载工作空间…" />
          </div>
        )
      );
    if (location.pathname === "/team") {
      const returnProject = (location.state as { projectId?: unknown } | null)?.projectId;
      return shell(
        projects.find((p) => p.id === returnProject)?.id ?? defaultProject?.id ?? "",
        "team",
      );
    }
    if (landing)
      return defaultProject ? (
        <Navigate replace to={projectPath(defaultProject.id)} />
      ) : (
        shell("", "overview")
      );
    if (!projectId) return <RouteMissing />;
    if (!projects.some((p) => p.id === projectId)) return <RouteMissing project />;
    if (page) return shell(projectId, page);
    if (projectMatch?.pathnameBase === location.pathname.replace(/\/$/, ""))
      return <Navigate replace to={projectPath(projectId)} />;
    return <RouteMissing />;
  }
  return (
    <>
      {error && (
        <Alert
          type="error"
          title={error}
          action={<Button onClick={() => void refreshProjects()}>重新加载项目</Button>}
        />
      )}
      {content()}
    </>
  );
}
