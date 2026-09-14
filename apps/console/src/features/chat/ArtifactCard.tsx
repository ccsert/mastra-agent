import type { RunArtifact } from "@platform/sdk";
import { Archive, Download, FileText, Globe, ImageIcon, PanelRightOpen } from "lucide-react";
import { useContext } from "react";
import { ArtifactCanvasContext, artifactUrl } from "./artifact-context";

export function ArtifactIcon({ file }: { file: RunArtifact }) {
  const Icon =
    file.mediaType === "text/html"
      ? Globe
      : file.mediaType.startsWith("image/")
        ? ImageIcon
        : file.mediaType === "application/zip"
          ? Archive
          : FileText;
  return <Icon size={16} aria-hidden="true" />;
}

/** File cards stay in the transcript; all inspection lives in the session canvas. */
export function ArtifactCard({
  file,
  files,
  projectId,
  runId,
}: {
  file: RunArtifact;
  files: RunArtifact[];
  projectId: string;
  runId: string;
}) {
  const canvas = useContext(ArtifactCanvasContext);
  const selected = canvas?.selected?.runId === runId && canvas.selected.fileId === file.id;
  return (
    <div className="chat-artifact" data-selected={selected}>
      <button
        type="button"
        className="chat-artifact-open"
        aria-label={`在右侧打开 ${file.name}`}
        onClick={(event) => canvas?.open({ runId, files, fileId: file.id }, event.currentTarget)}
      >
        <ArtifactIcon file={file} />
        <span>
          <strong>{file.name}</strong>
          <small>
            {file.source === "workspace"
              ? "任务产物"
              : file.source === "script-stdout"
                ? "脚本输出"
                : "工具结果"}{" "}
            · {Math.max(1, Math.ceil(file.size / 1024))} KB
          </small>
        </span>
        <PanelRightOpen size={14} aria-hidden="true" />
      </button>
      <a
        className="chat-artifact-download"
        href={artifactUrl(projectId, runId, file.id)}
        download={file.name}
        aria-label={`下载 ${file.name}`}
        title={`下载 · SHA-256 ${file.sha256}`}
      >
        <Download size={14} />
      </a>
    </div>
  );
}
