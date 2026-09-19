import type { RunArtifact } from "@platform/sdk";
import { Code2, Download, Eye, Monitor, RotateCcw, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ArtifactIcon } from "./ArtifactCard";

/** Generated HTML stays in an opaque origin. This policy must precede page code. */
const previewPolicy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
const maxTextBytes = 2 * 1024 * 1024;

// The owner keys this view by run + artifact + hash; file switches cannot display
// the previous file's response, even if a fetch completes after cancellation.
export function ArtifactPreview({
  file,
  url,
  inlineContent,
}: {
  file: RunArtifact;
  url: string;
  /** Transcript code blocks preview from memory; there is no stored file to fetch. */
  inlineContent?: string;
}) {
  const [mobile, setMobile] = useState(false),
    [source, setSource] = useState(false),
    [fetched, setFetched] = useState<string | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const inline = inlineContent != null;
  const text = inline ? inlineContent : fetched;
  const blobUrl = useMemo(() => {
    if (!inline) return null;
    return URL.createObjectURL(new Blob([inlineContent], { type: "text/html" }));
  }, [inline, inlineContent]);
  useEffect(
    () => () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    },
    [blobUrl],
  );
  const html = inline || file.mediaType === "text/html";
  const image =
    file.mediaType === "image/png" ||
    file.mediaType === "image/jpeg" ||
    file.mediaType === "image/webp";
  const readable =
    html || file.mediaType.startsWith("text/") || file.mediaType === "application/json";
  const tooLarge = readable && !inline && file.size > maxTextBytes;
  useEffect(() => {
    if (inline || !readable || tooLarge) return;
    const controller = new AbortController();
    setFetched(null);
    setError("");
    void fetch(url, { signal: controller.signal, cache: revision ? "reload" : "default" })
      .then(async (response) => {
        if (!response.ok) throw new Error("文件读取失败，请重试或下载原文件。");
        const content = await response.text();
        if (content.length > maxTextBytes) throw new Error("文件过大，请下载后查看。");
        if (!controller.signal.aborted) setFetched(content);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "文件读取失败");
      });
    return () => controller.abort();
  }, [url, readable, tooLarge, revision, inline]);
  const downloadHref = inline ? (blobUrl ?? url) : url;
  return (
    <div className="artifact-preview">
      <div className="artifact-preview-toolbar">
        {html ? (
          <fieldset className="artifact-control-group" aria-label="显示方式">
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
              <Eye size={14} />
              预览
            </button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
              <Code2 size={14} />
              源码
            </button>
          </fieldset>
        ) : (
          <span className="artifact-preview-kind">
            {image ? "图片预览" : readable ? "文件内容" : "文件信息"}
          </span>
        )}
        {html && !source && (
          <fieldset
            className="artifact-control-group artifact-viewport-controls"
            aria-label="预览尺寸"
          >
            <button
              type="button"
              aria-label="桌面预览"
              title="适应面板宽度"
              aria-pressed={!mobile}
              onClick={() => setMobile(false)}
            >
              <Monitor size={14} />
            </button>
            <button
              type="button"
              aria-label="手机预览"
              title="390px 手机宽度"
              aria-pressed={mobile}
              onClick={() => setMobile(true)}
            >
              <Smartphone size={14} />
            </button>
          </fieldset>
        )}
        <a
          className="artifact-download"
          href={downloadHref}
          download={file.name}
          title={inline ? "下载此 HTML 片段" : `SHA-256 ${file.sha256}`}
          aria-label={`下载当前文件 ${file.name}`}
        >
          <Download size={14} />
          <span>下载</span>
        </a>
      </div>
      <div className="artifact-preview-body" data-mobile={html && !source && mobile}>
        {error ? (
          <div className="artifact-preview-empty">
            <p role="alert">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError("");
                setRevision(revision + 1);
              }}
            >
              <RotateCcw size={14} />
              重新加载
            </button>
          </div>
        ) : tooLarge || (!readable && !image) ? (
          <div className="artifact-preview-empty">
            <ArtifactIcon file={file} />
            <strong>{file.name}</strong>
            <p>{tooLarge ? "文件较大，请下载后查看完整内容。" : "此格式可下载到本地查看。"}</p>
            <a href={url} download={file.name}>
              <Download size={14} />
              下载文件
            </a>
          </div>
        ) : image ? (
          <div className="artifact-image-stage">
            <img
              key={revision}
              src={url}
              alt={file.name}
              onError={() => setError("图片读取失败，请重试或下载原文件。")}
            />
          </div>
        ) : text === null ? (
          <div className="artifact-preview-empty" role="status">
            正在读取文件…
          </div>
        ) : html && !source ? (
          <iframe
            title={file.name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={previewPolicy + text}
          />
        ) : (
          <textarea
            className="artifact-source"
            readOnly
            spellCheck={false}
            wrap="off"
            aria-label={`${file.name} 源码`}
            value={text}
          />
        )}
      </div>
      <footer className="artifact-preview-meta">
        <span>
          {file.mediaType} · {Math.max(1, Math.ceil(file.size / 1024))} KB
        </span>
        <span>
          {html && !source ? (mobile ? "390px · 自适应窄屏" : "适应面板宽度") : "原始产物"}
        </span>
      </footer>
    </div>
  );
}
