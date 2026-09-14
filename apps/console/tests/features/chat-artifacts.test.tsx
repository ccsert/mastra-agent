import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { RunArtifact } from "@platform/sdk";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { ArtifactCanvas } from "../../src/features/chat/ArtifactCanvas.tsx";
import { ArtifactCard } from "../../src/features/chat/ArtifactCard.tsx";
import { ArtifactPreview } from "../../src/features/chat/ArtifactPreview.tsx";
import { ArtifactCanvasContext } from "../../src/features/chat/artifact-context.ts";
import { ChatToolContent } from "../../src/features/chat/ChatToolContent.tsx";

const base: RunArtifact = {
  id: "html",
  name: "index.html",
  mediaType: "text/html",
  size: 64,
  sha256: "hash",
  source: "workspace",
  toolCallId: "call",
  subagentId: null,
  createdAt: "2026-09-13T00:00:00Z",
};
const files = [
  base,
  { ...base, id: "image", name: "screen.png", mediaType: "image/png" },
  { ...base, id: "zip", name: "source.zip", mediaType: "application/zip" },
];
function ArtifactCards({ runId }: { runId: string }) {
  return (
    <>
      {files.map((file) => (
        <ArtifactCard key={file.id} file={file} files={files} runId={runId} projectId="project" />
      ))}
    </>
  );
}

afterEach(cleanup);

test("screenshots display bounded images without printing base64 in the tool panel", () => {
  const png = "iVBORw0KGgo=";
  const { container } = render(
    <ChatToolContent
      toolName="browser_screenshot"
      args={{}}
      result={{ base64: png, artifact: { name: "screen.png" } }}
    />,
  );
  assert.equal(screen.getByRole("img").getAttribute("src"), `data:image/png;base64,${png}`);
  assert.equal(container.textContent?.includes(png), false);
});

test("generated HTML uses an opaque sandbox and a restrictive policy before page code", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response('<script>document.body.textContent="Preview"</script>'),
  );
  render(
    <ArtifactPreview
      url="/owned-artifact"
      file={{
        id: "file-00000000-0000-0000-0000-000000000000",
        name: "index.html",
        mediaType: "text/html",
        size: 64,
        sha256: "hash",
        source: "workspace",
        toolCallId: "call",
        subagentId: null,
        createdAt: "2026-09-13T00:00:00Z",
      }}
    />,
  );
  await waitFor(() => assert.ok(screen.getByTitle("index.html")));
  const frame = screen.getByTitle("index.html");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.match(frame.getAttribute("srcdoc") ?? "", /^<meta http-equiv="Content-Security-Policy"/);
  assert.match(frame.getAttribute("srcdoc") ?? "", /connect-src 'none'/);
});

test("file inspection stays in the canvas while drafts and the chat mount survive switching and closing", async (t) => {
  let mounts = 0;
  t.mock.method(globalThis, "fetch", async () => new Response("<h1>Page one</h1>"));
  function Transcript() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <>
        <textarea aria-label="消息草稿" />
        <ArtifactCards runId="run-one" />
      </>
    );
  }
  const view = render(
    <ArtifactCanvas key="first-conversation" projectId="project">
      <Transcript />
    </ArtifactCanvas>,
  );
  const draft = screen.getByRole("textbox", { name: "消息草稿" });
  fireEvent.change(draft, { target: { value: "继续调整排版" } });
  assert.equal(screen.queryByTitle("index.html"), null);
  const entry = screen.getByRole("button", { name: "在右侧打开 index.html" });
  fireEvent.click(entry);
  const canvas = screen.getByRole("region", { name: "产物" });
  await waitFor(() => assert.ok(canvas.querySelector("iframe")));
  assert.equal(draft, screen.getByRole("textbox", { name: "消息草稿" }));
  assert.equal(document.activeElement, canvas);
  assert.equal(entry.closest(".chat-artifact")?.querySelector("iframe"), null);
  fireEvent.click(screen.getByRole("button", { name: "手机预览" }));
  assert.equal(
    screen.getByRole("button", { name: "手机预览" }).getAttribute("aria-pressed"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  assert.equal(
    screen.getByRole("textbox", { name: "index.html 源码" }).getAttribute("readonly"),
    "",
  );
  assert.equal(screen.queryByTitle("index.html")?.tagName === "IFRAME", false);
  fireEvent.click(screen.getByRole("tab", { name: "screen.png" }));
  assert.equal(
    screen.getByRole("img").getAttribute("src"),
    "/api/v1/projects/project/runs/run-one/artifacts/image",
  );
  fireEvent.click(screen.getByRole("tab", { name: "source.zip" }));
  assert.ok(screen.getByText("此格式可下载到本地查看。"));
  assert.equal(
    screen.getByRole("link", { name: "下载当前文件 source.zip" }).getAttribute("href"),
    "/api/v1/projects/project/runs/run-one/artifacts/zip",
  );
  fireEvent.click(screen.getByRole("button", { name: "放大产物面板" }));
  fireEvent.click(screen.getByRole("button", { name: "还原并排" }));
  fireEvent.keyDown(canvas, { key: "Escape" });
  assert.equal(screen.queryByRole("region", { name: "产物" }), null);
  assert.equal(document.activeElement, entry);
  assert.equal(mounts, 1);
  assert.equal(Reflect.get(draft, "value"), "继续调整排版");
  fireEvent.click(screen.getByRole("button", { name: "打开产物面板" }));
  assert.equal(
    screen.getByRole("tab", { name: "source.zip" }).getAttribute("aria-selected"),
    "true",
  );
  view.rerender(
    <ArtifactCanvas key="second-conversation" projectId="project">
      <textarea aria-label="新会话草稿" />
    </ArtifactCanvas>,
  );
  assert.equal(screen.queryByRole("region", { name: "产物" }), null);
  assert.equal(screen.queryByRole("button", { name: "打开产物面板" }), null);
});

test("switching runs aborts obsolete reads and cannot show the other run's same-named HTML", async (t) => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  let aborted: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("run-one")) {
      aborted = init?.signal;
      return pending;
    }
    return new Response("<h1>Second run only</h1>");
  });
  render(
    <ArtifactCanvas projectId="project">
      <ArtifactCards runId="run-one" />
      <ArtifactCards runId="run-two" />
    </ArtifactCanvas>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "在右侧打开 index.html" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "在右侧打开 index.html" })[1]);
  assert.equal(aborted?.aborted, true);
  await act(async () => resolve(new Response("<h1>Obsolete first run</h1>")));
  await waitFor(() =>
    assert.match(document.querySelector("iframe")?.getAttribute("srcdoc") ?? "", /Second run only/),
  );
  assert.doesNotMatch(document.querySelector("iframe")?.getAttribute("srcdoc") ?? "", /Obsolete/);
});

test("new artifacts update the selected run without stealing selection or reopening a closed canvas", async () => {
  const expandedFiles = [...files, { ...files[1], id: "new-image", name: "new.png" }];
  function LiveFiles({ current }: { current: RunArtifact[] }) {
    const updateFiles = useContext(ArtifactCanvasContext)?.updateFiles;
    useEffect(() => {
      updateFiles?.("run-one", current);
    }, [updateFiles, current]);
    return <ArtifactCard file={current[1]} files={current} runId="run-one" projectId="project" />;
  }
  const view = render(
    <ArtifactCanvas projectId="project">
      <LiveFiles current={files} />
    </ArtifactCanvas>,
  );
  fireEvent.click(screen.getByRole("button", { name: "在右侧打开 screen.png" }));
  view.rerender(
    <ArtifactCanvas projectId="project">
      <LiveFiles current={expandedFiles} />
    </ArtifactCanvas>,
  );
  assert.ok(screen.getByRole("tab", { name: "new.png" }));
  assert.equal(
    screen.getByRole("tab", { name: "screen.png" }).getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭产物面板" }));
  view.rerender(
    <ArtifactCanvas projectId="project">
      <LiveFiles current={files} />
    </ArtifactCanvas>,
  );
  assert.equal(screen.queryByRole("region", { name: "产物" }), null);
});

test("failed reads can retry and oversized text stays downloadable without fetching", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("", { status: 503 }),
  );
  const view = render(<ArtifactPreview file={files[0]} url="/file" />);
  await screen.findByRole("alert");
  fetchMock.mock.mockImplementation(async () => new Response("Recovered"));
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() =>
    assert.match(document.querySelector("iframe")?.getAttribute("srcdoc") ?? "", /Recovered/),
  );
  view.rerender(<ArtifactPreview key="large" file={{ ...files[0], size: 3000000 }} url="/large" />);
  assert.ok(screen.getByText("文件较大，请下载后查看完整内容。"));
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("narrow containers use a modal drawer and restore focus only after it has closed", async (t) => {
  let resize: ((width: number) => void) | undefined;
  const previous = globalThis.ResizeObserver;
  t.after(() =>
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previous }),
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains("chat-canvas-layout"))
          resize = (width) =>
            this.callback(
              [
                {
                  target,
                  contentRect: new window.DOMRect(0, 0, width, 800),
                  borderBoxSize: [],
                  contentBoxSize: [],
                  devicePixelContentBoxSize: [],
                },
              ],
              this,
            );
      }
      unobserve() {}
      disconnect() {}
    },
  });
  render(
    <ArtifactCanvas projectId="project">
      <textarea aria-label="消息草稿" />
      <ArtifactCards runId="run-one" />
    </ArtifactCanvas>,
  );
  const draft = screen.getByRole("textbox", { name: "消息草稿" });
  fireEvent.change(draft, { target: { value: "保留的草稿" } });
  assert.ok(resize);
  await act(async () => resize?.(390));
  const entry = screen.getByRole("button", { name: "在右侧打开 screen.png" });
  fireEvent.click(entry);
  await screen.findByRole("dialog", { name: "产物预览" });
  assert.equal(screen.queryByRole("button", { name: "放大产物面板" }), null);
  fireEvent.click(screen.getByRole("button", { name: "关闭产物面板" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "产物预览" }), null));
  await waitFor(() => assert.equal(document.activeElement, entry));
  assert.equal(screen.getByRole("textbox", { name: "消息草稿" }), draft);
  assert.equal(Reflect.get(draft, "value"), "保留的草稿");
});
