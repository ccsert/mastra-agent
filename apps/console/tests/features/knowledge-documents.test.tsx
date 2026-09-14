import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { DocumentSource } from "@platform/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { DocumentImport } from "../../src/features/knowledge/DocumentImport.tsx";
import { DocumentReader, SourceSections } from "../../src/features/knowledge/DocumentReader.tsx";

afterEach(cleanup);
test("a citation spanning paragraphs opens the complete source range and highlights its evidence", () => {
  mount(
    <SourceSections
      sections={preview.sections}
      initialIndex={1}
      initialEndIndex={2}
      excerpt={"编辑者不能发布。\n\n管理员复核。"}
    />,
  );
  assert.equal(document.querySelector("mark")?.textContent, "编辑者不能发布。\n\n管理员复核。");
  assert.ok(screen.getByRole("heading", { name: "段落 1–2" }));
});
const preview = {
  id: "preview",
  filename: "规则.docx",
  format: "docx",
  contentHash: "hash",
  byteSize: 12,
  sections: [
    { location: { kind: "paragraph", index: 1 }, content: "编辑者不能发布。" },
    { location: { kind: "paragraph", index: 2 }, content: "管理员复核。" },
  ] satisfies DocumentSource["sections"],
  chunks: [{ ordinal: 0, content: "编辑者不能发布。", location: { kind: "paragraph", index: 1 } }],
  warnings: ["合成预览"],
  expiresAt: "2026-09-14",
  documentId: null,
  baseVersion: null,
  unchanged: false,
};
const version = {
  id: "v1",
  documentId: "document",
  version: 1,
  filename: "规则.docx",
  contentHash: "hash",
  format: "docx",
  byteSize: 12,
  status: "ready",
  chunkCount: 1,
  indexedCount: 1,
  errorCode: null,
  active: false,
  createdAt: "2026-09-13",
  warnings: [],
};
function mount(child: React.ReactNode) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          {child}
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
}
function uploadFile() {
  const input = document.querySelector("input[type=file]");
  assert.ok(input);
  const file = new File(["fixture"], "规则.docx");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("fixture").buffer,
  });
  fireEvent.change(input, { target: { files: [file] } });
}
test("knowledge upload requires reviewing parsed content and confirms only the fixed preview", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let imported = false;
  globalThis.fetch = async (input) => {
    const req = input as Request;
    calls.push({ path: new URL(req.url).pathname, body: JSON.parse(await req.text()) });
    return Response.json(calls.length === 1 ? preview : { id: "document" });
  };
  mount(
    <DocumentImport
      projectId="project"
      kbId="kb"
      onClose={() => {}}
      onImported={() => {
        imported = true;
      }}
    />,
  );
  assert.equal(screen.getByRole("button", { name: /确认入库/ }).hasAttribute("disabled"), true);
  uploadFile();
  await screen.findByText("编辑者不能发布。");
  assert.equal(calls.length, 1);
  fireEvent.click(screen.getByRole("tab", { name: "分段预览" }));
  await screen.findByRole("columnheader", { name: "位置" });
  fireEvent.click(screen.getByRole("button", { name: /确认入库/ }));
  await waitFor(() => assert.ok(imported));
  assert.deepEqual(calls[1].body, { previewId: "preview" });
});
test("knowledge import shows stale update error and cancellation discards late parse results", async () => {
  let release: (response: Response) => void = () => {};
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  let closed = false;
  const view = mount(
    <DocumentImport
      projectId="project"
      kbId="kb"
      onClose={() => {
        closed = true;
        view.unmount();
      }}
      onImported={() => {
        throw new Error("unexpected");
      }}
    />,
  );
  uploadFile();
  await screen.findByText("正在解析文件…");
  fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  assert.equal(closed, true);
  release(Response.json(preview));
  await Promise.resolve();
  assert.equal(screen.queryByText("编辑者不能发布。"), null);
  globalThis.fetch = async (input) =>
    Response.json(
      new URL((input as Request).url).pathname.endsWith("document-previews")
        ? preview
        : { message: "文档已被更新，请重新预览后提交", code: "DOCUMENT_STALE" },
      {
        status: new URL((input as Request).url).pathname.endsWith("document-previews") ? 200 : 409,
      },
    );
  mount(
    <DocumentImport
      projectId="project"
      kbId="kb"
      onClose={() => {}}
      onImported={() => {
        throw new Error("unexpected");
      }}
    />,
  );
  uploadFile();
  await screen.findByText("编辑者不能发布。");
  fireEvent.click(screen.getByRole("button", { name: /确认入库/ }));
  await screen.findByText("文档已被更新，请重新预览后提交");
  assert.ok(screen.getByRole("tab", { name: "解析正文" }));
});
test("source reader requests a fixed historical version and locates the cited paragraph", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL((input as Request).url);
    requests.push(url.toString());
    return Response.json(
      url.pathname.endsWith("versions")
        ? [version]
        : { version, sections: preview.sections, chunks: preview.chunks },
    );
  };
  mount(
    <DocumentReader
      projectId="project"
      kbId="kb"
      documentId="document"
      versionId="v1"
      location={{ kind: "paragraph", index: 2 }}
      excerpt="管理员复核。"
      onClose={() => {}}
    />,
  );
  await screen.findByText("管理员复核。");
  assert.ok(document.querySelector("mark"));
  assert.ok(requests.some((r) => r.includes("versionId=v1")));
  fireEvent.click(screen.getByRole("tab", { name: /版本记录/ }));
  await screen.findByRole("columnheader", { name: "版本" });
  assert.ok(screen.getByRole("button", { name: "v1" }));
});
