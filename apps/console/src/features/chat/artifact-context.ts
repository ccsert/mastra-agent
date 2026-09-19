import type { RunArtifact } from "@platform/sdk";
import { createContext } from "react";

export type ArtifactSelection = { runId: string; files: RunArtifact[]; fileId: string };
/** A code block from the transcript, previewed without a stored artifact. */
export type InlineArtifact = { id: string; name: string; content: string };
export const ArtifactCanvasContext = createContext<{
  selected: ArtifactSelection | null;
  open(selection: ArtifactSelection, trigger: HTMLElement): void;
  updateFiles(runId: string, files: RunArtifact[]): void;
  openInline(file: InlineArtifact): void;
} | null>(null);

export function artifactUrl(projectId: string, runId: string, fileId: string) {
  return `/api/v1/projects/${projectId}/runs/${runId}/artifacts/${fileId}`;
}
