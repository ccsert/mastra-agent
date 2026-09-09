import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { KnowledgeBase } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router";
import { ChatWorkspace } from "../../src/features/chat/index.ts";
import { KnowledgeDetails } from "../../src/features/knowledge/KnowledgeDetails.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
const kb: KnowledgeBase = {
  id: "kb",
  projectId: "project",
  name: "Knowledge",
  description: "",
  embeddingModelId: "model",
  rerankModelId: null,
  chunkSize: 500,
  chunkOverlap: 50,
  dimensions: 1024,
  documentCount: 23,
  readyCount: 23,
  chunkCount: 23,
  createdAt: "2026-01-01",
};
for (const kind of ["conversations", "documents"] as const) {
  test(`${kind} load one page, preserve it on next-page failure and cancel a pending continuation on close`, async (t) => {
    let fail = true;
    let pending: Request | undefined;
    const reads: (string | null)[] = [];
    const item = (n: number) =>
      kind === "conversations"
        ? {
            id: `conversation-${n}`,
            projectId: "project",
            agentId: "agent",
            releaseId: "release",
            releaseVersion: 1,
            title: `合成会话 ${n}`,
            createdAt: "2026-01-01",
          }
        : {
            id: `document-${n}`,
            knowledgeBaseId: kb.id,
            filename: `合成文档 ${n}.md`,
            contentHash: `hash-${n}`,
            status: "ready",
            chunkCount: 1,
            errorCode: null,
            createdAt: "2026-01-01",
          };
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init),
        url = new URL(req.url),
        cursor = url.searchParams.get("cursor");
      assert.equal(url.searchParams.get("limit"), "20");
      assert.ok(url.pathname.endsWith(`/${kind}`));
      reads.push(cursor);
      if (!cursor)
        return Response.json(
          Array.from({ length: 20 }, (_, n) => item(n + 1)),
          { headers: { "X-Next-Cursor": "next" } },
        );
      if (cursor === "pending") {
        pending = req;
        return new Promise<Response>((_resolve, reject) =>
          req.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      }
      assert.equal(cursor, "next");
      return fail
        ? Response.json({ message: "分页合成故障" }, { status: 503 })
        : Response.json([item(21), item(22), item(23)], {
            headers: { "X-Next-Cursor": "pending" },
          });
    });
    const view = render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <ProjectData projectId="project">
            {kind === "conversations" ? (
              <MemoryRouter>
                <ChatWorkspace onSelect={() => {}} onCreate={() => {}} />
              </MemoryRouter>
            ) : (
              <KnowledgeDetails kb={kb} models={[]} />
            )}
          </ProjectData>
        </App>
      </ConfigProvider>,
    );
    const label = kind === "conversations" ? "会话" : "文档";
    const text = (n: number) => `合成${label} ${n}${kind === "documents" ? ".md" : ""}`;
    await screen.findByText(text(20));
    assert.equal(screen.queryByText(text(21)), null);
    assert.deepEqual(reads, [null], "opening the directory must not eagerly fetch every page");
    fireEvent.click(screen.getByRole("button", { name: `加载更多${label}` }));
    await screen.findByText(/分页合成故障/);
    assert.ok(screen.getByText(text(1)));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: `重试加载更多${label}` }));
    await screen.findByText(text(23));
    assert.equal(screen.getAllByText(text(1)).length, 1);
    fireEvent.click(screen.getByRole("button", { name: `加载更多${label}` }));
    await waitFor(() => assert.ok(pending));
    view.unmount();
    await waitFor(() => assert.equal(pending?.signal.aborted, true));
  });
}
