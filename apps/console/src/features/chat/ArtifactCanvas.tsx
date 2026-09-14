import { Drawer, Splitter, Tabs } from "antd";
import { FolderOpen, Maximize2, Minimize2, PanelRightOpen, X } from "lucide-react";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArtifactIcon } from "./ArtifactCard";
import { ArtifactPreview } from "./ArtifactPreview";
import { ArtifactCanvasContext, type ArtifactSelection, artifactUrl } from "./artifact-context";

/** Owned by the keyed conversation, not an individual message. Keep the chat
 * mounted in the same panel while opening, resizing, or maximizing the canvas. */
export function ArtifactCanvas({ projectId, children }: PropsWithChildren<{ projectId: string }>) {
  const [selection, setSelection] = useState<ArtifactSelection | null>(null),
    [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState(false),
    [narrow, setNarrow] = useState(false),
    [chatWidth, setChatWidth] = useState(44);
  const canvas = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const headingId = useId();
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setNarrow(entry.contentRect.width < 900);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const openFile = useCallback((next: ArtifactSelection, from: HTMLElement) => {
    trigger.current = from;
    setSelection(next);
    setOpen(true);
  }, []);
  const updateFiles = useCallback((runId: string, files: ArtifactSelection["files"]) => {
    setSelection((previous) =>
      previous?.runId === runId && previous.files !== files
        ? {
            ...previous,
            files,
            fileId: files.some((file) => file.id === previous.fileId)
              ? previous.fileId
              : (files[0]?.id ?? ""),
          }
        : previous,
    );
  }, []);
  const context = useMemo(
    () => ({ selected: open ? selection : null, open: openFile, updateFiles }),
    [selection, open, openFile, updateFiles],
  );
  const restoreFocus = () => {
    const target = trigger.current?.isConnected
      ? trigger.current
      : root.current?.querySelector<HTMLButtonElement>(".chat-canvas-reopen button");
    target?.focus({ preventScroll: true });
  };
  const close = () => {
    setOpen(false);
    setExpanded(false);
    if (!narrow) restoreFocus();
  };
  const file = selection?.files.find((item) => item.id === selection.fileId);
  const shown = open && !!file;
  const docked = shown && !narrow;
  useEffect(() => {
    if (shown && !narrow) canvas.current?.focus({ preventScroll: true });
  }, [shown, narrow]);
  const panel =
    selection && file ? (
      <section
        ref={canvas}
        tabIndex={-1}
        className="artifact-canvas"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="artifact-canvas-header">
          <FolderOpen size={16} aria-hidden="true" />
          <h2 id={headingId}>产物</h2>
          <span>本轮 · {selection.files.length} 个文件</span>
          <div className="artifact-canvas-actions">
            {!narrow && (
              <button
                type="button"
                aria-label={expanded ? "还原并排" : "放大产物面板"}
                title={expanded ? "还原并排" : "放大产物面板"}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}
            <button type="button" aria-label="关闭产物面板" title="关闭产物面板" onClick={close}>
              <X size={17} />
            </button>
          </div>
        </header>
        <Tabs
          className="artifact-file-tabs"
          size="small"
          activeKey={file.id}
          onChange={(fileId) => setSelection({ ...selection, fileId })}
          items={selection.files.map((item) => ({
            key: item.id,
            icon: <ArtifactIcon file={item} />,
            label: <span title={item.name}>{item.name}</span>,
          }))}
        />
        <ArtifactPreview
          key={`${selection.runId}/${file.id}/${file.sha256}`}
          file={file}
          url={artifactUrl(projectId, selection.runId, file.id)}
        />
      </section>
    ) : null;
  return (
    <ArtifactCanvasContext.Provider value={context}>
      <div ref={root} className="chat-canvas-layout" data-canvas-open={docked}>
        <Splitter
          onResize={(sizes) => {
            const total = sizes.reduce((sum, size) => sum + size, 0);
            if (total > 0 && docked && !expanded) setChatWidth((sizes[0] / total) * 100);
          }}
          onDraggerDoubleClick={() => setChatWidth(44)}
        >
          <Splitter.Panel
            className="chat-canvas-conversation"
            size={docked ? (expanded ? 0 : `${chatWidth}%`) : "100%"}
            min={docked && !expanded ? "32%" : 0}
            resizable={docked && !expanded}
          >
            {selection && (
              <div className="chat-canvas-reopen">
                <button
                  type="button"
                  aria-label="打开产物面板"
                  onClick={(event) => openFile(selection, event.currentTarget)}
                >
                  <PanelRightOpen size={14} />
                  <span>{file?.name ?? "本轮产物"}</span>
                </button>
              </div>
            )}
            {children}
          </Splitter.Panel>
          <Splitter.Panel
            className="chat-canvas-side"
            size={docked ? (expanded ? "100%" : `${100 - chatWidth}%`) : 0}
            min={docked ? "35%" : 0}
            resizable={docked && !expanded}
          >
            {docked && panel}
          </Splitter.Panel>
        </Splitter>
        {narrow && (
          <Drawer
            open={shown}
            afterOpenChange={(visible) => {
              if (visible) canvas.current?.focus({ preventScroll: true });
              else restoreFocus();
            }}
            onClose={close}
            placement="right"
            size="100%"
            closable={false}
            destroyOnHidden
            focusable={{ trap: true, focusTriggerAfterClose: false }}
            aria-label="产物预览"
            styles={{ body: { padding: 0, overflow: "hidden" } }}
          >
            {shown && panel}
          </Drawer>
        )}
      </div>
    </ArtifactCanvasContext.Provider>
  );
}
