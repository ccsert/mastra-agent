import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { SkillWorkspace } from "../../src/features/skills/SkillWorkspace.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";
import { Selection } from "../helpers/selection.tsx";

afterEach(cleanup);
function mount() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="skill-project">
          <Selection>{(selection) => <SkillWorkspace {...selection} />}</Selection>
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
}
const version = {
  id: "skill-version",
  projectId: "skill-project",
  version: 1,
  name: "order-summary",
  description: "合成订单报表",
  enabled: true,
  createdAt: "2026-09-09T00:00:00Z",
  digest: "abc",
  archiveHash: "def",
  files: [{ path: "SKILL.md", hash: "test", size: 6, encoding: "utf-8" }],
  entrypoints: [],
  warnings: [],
  metadata: {},
};
test("Skill directory errors remain retryable and closing details cancels plaintext requests", async () => {
  let fail = true,
    fileSignal: AbortSignal | undefined;
  globalThis.fetch = async (input) => {
    const req = input as Request,
      url = new URL(req.url);
    if (url.pathname.endsWith("/file")) {
      fileSignal = req.signal;
      return new Promise<Response>((_resolve, reject) =>
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    }
    if (url.pathname.endsWith("/skills"))
      return fail
        ? Response.json({ message: "目录暂时不可用" }, { status: 503 })
        : Response.json([version]);
    if (url.pathname.endsWith("/skills/skill-version")) return Response.json(version);
    throw new Error("Unexpected request");
  };
  mount();
  await screen.findByText("目录暂时不可用");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));
  fireEvent.click(await screen.findByRole("button", { name: /order-summary/ }));
  await waitFor(() => assert.ok(fileSignal));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => assert.ok(fileSignal?.aborted));
  assert.ok(screen.getByRole("button", { name: /order-summary/ }));
});
test("failed Skill imports retain the chosen file for retry and a closed importer cannot reopen details", async () => {
  let uploads = 0,
    resolveUpload: ((response: Response) => void) | undefined,
    uploadSignal: AbortSignal | undefined;
  globalThis.fetch = async (input) => {
    const req = input as Request;
    if (req.method === "GET") return Response.json([]);
    uploads++;
    if (uploads === 1)
      return Response.json({ message: "ZIP 根目录缺少 SKILL.md" }, { status: 400 });
    uploadSignal = req.signal;
    return new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
  };
  mount();
  fireEvent.click(screen.getByRole("button", { name: /导入 Skill 包/ }));
  const input = document.querySelector("input[type=file]");
  assert.ok(input);
  fireEvent.change(input, {
    target: { files: [new File(["zip-test"], "sample.zip", { type: "application/zip" })] },
  });
  await screen.findByText("sample.zip");
  fireEvent.click(screen.getByRole("button", { name: "校验并导入" }));
  await screen.findByText("ZIP 根目录缺少 SKILL.md");
  assert.ok(screen.getByText("sample.zip"));
  fireEvent.click(screen.getByRole("button", { name: "校验并导入" }));
  await waitFor(() => assert.equal(uploads, 2));
  fireEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  await waitFor(() => assert.ok(uploadSignal?.aborted));
  resolveUpload?.(Response.json(version));
  await waitFor(() => assert.equal(screen.queryByText("合成订单报表"), null));
});
