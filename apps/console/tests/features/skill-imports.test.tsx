import "../helpers/dom.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SkillImportPreview, SkillVersion } from "@platform/sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, ConfigProvider } from "antd";
import { SkillImport } from "../../src/features/skills/SkillImport.tsx";
import { ProjectData } from "../../src/shared/data/ProjectData.tsx";

afterEach(cleanup);
const sha = "a".repeat(40),
  source = {
    kind: "github" as const,
    url: "https://github.com/owner/repo",
    repository: "owner/repo",
    ref: "main",
    commit: sha,
    path: "skills/test",
  };
const manifest = {
  name: "test-skill",
  description: "Example instructions",
  metadata: {},
  files: [{ path: "SKILL.md", size: 20, hash: "a".repeat(64), encoding: "utf-8" as const }],
  entrypoints: ["scripts/run.py"],
  warnings: ["扩展字段 hooks 不会生效"],
  extensionFields: ["hooks"],
  compatibility: "Python with dependencies",
};
const preview: SkillImportPreview = {
  id: "preview",
  expiresAt: "2030-01-01T00:00:00Z",
  source,
  manifest,
  digest: "digest",
  baseVersion: null,
  existingVersion: null,
  changes: [{ path: "SKILL.md", kind: "added" }],
};
const skill: SkillVersion = {
  ...manifest,
  id: "version",
  projectId: "A",
  version: 1,
  digest: "digest",
  archiveHash: "archive",
  enabled: true,
  createdAt: "2026-09-13",
  source,
};
function mount(initialPreview?: SkillImportPreview, onImported = (_skill: SkillVersion) => {}) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ProjectData projectId="A">
          <SkillImport initialPreview={initialPreview} onClose={() => {}} onImported={onImported} />
        </ProjectData>
      </App>
    </ConfigProvider>,
  );
}
const content = (text: string) =>
  Response.json({ path: "SKILL.md", hash: "a".repeat(64), contentBase64: btoa(text) });

test("source discovery selects a subdirectory and confirms only the reviewed preview", async (t) => {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  let imported: SkillVersion | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      url = new URL(req.url).pathname;
    const body =
      req.method === "POST" && req.headers.get("content-type")?.includes("json")
        ? await req.json()
        : undefined;
    calls.push({ url, body });
    if (url.endsWith("/discover"))
      return Response.json({
        source,
        candidates: [
          { name: "test-skill", path: "skills/test", fileCount: 1 },
          { name: "another", path: "skills/another", fileCount: 3 },
        ],
      });
    if (url.endsWith("/previews")) return Response.json(preview);
    if (url.endsWith("/confirm")) return Response.json({ skill, reused: false });
    return content("# REVIEWED CONTENT");
  });
  mount(undefined, (value) => {
    imported = value;
  });
  fireEvent.change(screen.getByRole("textbox", { name: "仓库或 Skill 详情链接" }), {
    target: { value: "owner/repo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析来源" }));
  await screen.findByText("找到 2 个 Skill");
  assert.equal(
    calls.some((c) => c.url.endsWith("/confirm")),
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "预览 test-skill" }));
  await screen.findByText("# REVIEWED CONTENT");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/previews"))?.body, {
    kind: "remote",
    source: { url: "owner/repo" },
    commit: sha,
    path: "skills/test",
  });
  fireEvent.click(screen.getByRole("tab", { name: "兼容性与执行要求" }));
  await screen.findByText("扩展字段 hooks 不会生效");
  assert.ok(screen.getByText("Python with dependencies"));
  fireEvent.click(screen.getByRole("button", { name: "确认导入固定版本" }));
  await waitFor(() => assert.equal(imported?.id, "version"));
  assert.equal(calls.filter((c) => c.url.endsWith("/confirm")).length, 1);
  assert.deepEqual(calls.at(-1)?.body, {});
});

test("editing the source invalidates discovered candidates and stale confirmation errors remain reviewable", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith("/discover"))
      return Response.json({
        source,
        candidates: [{ name: "test-skill", path: "skills/test", fileCount: 1 }],
      });
    if (path.endsWith("/confirm"))
      return Response.json(
        { code: "SKILL_IMPORT_STALE", message: "预览后已有其他人导入新版本，请重新预览" },
        { status: 409 },
      );
    return content("review me");
  });
  mount();
  const input = screen.getByRole("textbox", { name: "仓库或 Skill 详情链接" });
  fireEvent.change(input, { target: { value: "owner/repo" } });
  fireEvent.click(screen.getByRole("button", { name: "解析来源" }));
  await screen.findByText("找到 1 个 Skill");
  fireEvent.change(input, { target: { value: "other/repo" } });
  assert.equal(screen.queryByRole("button", { name: "预览 test-skill" }), null);
  cleanup();
  mount(preview);
  await screen.findByText("review me");
  fireEvent.click(screen.getByRole("button", { name: "确认导入固定版本" }));
  await screen.findByText("预览后已有其他人导入新版本，请重新预览");
  assert.ok(screen.getByRole("button", { name: "确认导入固定版本" }));
});

test("update review shows removed file contents and warns when existing content is disabled", async (t) => {
  const base: SkillVersion = {
    ...skill,
    files: [
      ...skill.files,
      { path: "removed.md", hash: "b".repeat(64), size: 10, encoding: "utf-8" },
    ],
  };
  const updated: SkillImportPreview = {
    ...preview,
    baseVersion: base,
    changes: [{ path: "removed.md", kind: "removed" }],
  };
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.url);
    return content(req.url.includes("removed.md") ? "REMOVED TEXT" : "CURRENT TEXT");
  });
  mount(updated);
  fireEvent.click(screen.getByRole("tab", { name: "版本差异 · 1" }));
  fireEvent.click(await screen.findByRole("button", { name: "removed.md" }));
  await screen.findByText("REMOVED TEXT");
  assert.ok(screen.getByText("新版已移除此文件"));
  assert.equal(
    calls.some((c) => c.includes("/previews/") && c.includes("removed.md")),
    false,
  );
  cleanup();
  mount({ ...preview, existingVersion: { ...skill, enabled: false } });
  assert.ok(screen.getByText(/完全一致，将复用现有版本（已停用）/));
  assert.ok(screen.getByRole("button", { name: "使用已有版本" }));
});
