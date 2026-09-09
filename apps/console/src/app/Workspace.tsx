import type { Project } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Spin } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { unwrap } from "../shared/api";
import { ProjectData } from "../shared/data/ProjectData";
import { useLifetime } from "../shared/useLifetime";
import type { ConsoleSession } from "./auth/SessionBoundary";
import { ProjectConsole } from "./ProjectConsole";

export function Workspace(session: ConsoleSession) {
  const lifetime = useLifetime();
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
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
        setProjectId((previous) =>
          chooseNewest
            ? (items.at(-1)?.id ?? "")
            : items.some((project) => project.id === previous)
              ? previous
              : (items[0]?.id ?? ""),
        );
        setError("");
        setReady(true);
      } catch (error) {
        if (!signal.aborted && current === request.current)
          setError(error instanceof Error ? error.message : "无法读取项目");
      }
    },
    [lifetime],
  );
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);
  return (
    <>
      {error && (
        <Alert
          type="error"
          title={error}
          action={<Button onClick={() => void refreshProjects()}>重新加载项目</Button>}
        />
      )}
      {ready ? (
        <ProjectData key={projectId} projectId={projectId}>
          <ProjectConsole
            {...session}
            projects={projects}
            projectId={projectId}
            onProjectChange={setProjectId}
            refreshProjects={refreshProjects}
          />
        </ProjectData>
      ) : (
        !error && (
          <div className="full-loader">
            <Spin description="加载工作空间…" />
          </div>
        )
      )}
    </>
  );
}
