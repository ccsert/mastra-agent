import type { RunArtifact } from "@platform/sdk";
import { createContext } from "react";

export type ArtifactSelection = { runId: string; files: RunArtifact[]; fileId: string };
export const ArtifactCanvasContext = createContext<{
  selected: ArtifactSelection | null;
  open(selection: ArtifactSelection, trigger: HTMLElement): void;
  updateFiles(runId: string, files: RunArtifact[]): void;
} | null>(null);

export function artifactUrl(projectId: string, runId: string, fileId: string) {
  return `/api/v1/projects/${projectId}/runs/${runId}/artifacts/${fileId}`;
}
