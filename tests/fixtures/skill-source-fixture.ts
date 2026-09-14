import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { skillDoc } from "./skill-fixture.ts";

export const firstCommit = "a".repeat(40),
  secondCommit = "b".repeat(40);
export const gitBlobHash = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
export function sourceFixture() {
  const versions = new Map([
    [
      firstCommit,
      new Map([
        [
          "skills/report/SKILL.md",
          skillDoc("ONE").replace(
            "metadata:",
            "model: claude-test\nhooks:\n  run: never-execute\nmetadata:",
          ),
        ],
        ["skills/report/scripts/report.mjs", "console.log('one')"],
        ["skills/report/references/removed.md", "old reference"],
        ["skills/guide/SKILL.md", "---\nname: guide\ndescription: Read only\n---\n# Guide"],
      ]),
    ],
    [
      secondCommit,
      new Map([
        ["skills/report/SKILL.md", skillDoc("TWO")],
        ["skills/report/scripts/report.mjs", "console.log('two')"],
        ["skills/report/references/new.md", "new reference"],
        ["skills/guide/SKILL.md", "---\nname: guide\ndescription: Read only\n---\n# Guide"],
      ]),
    ],
  ]);
  const fixture = {
    commit: firstCommit,
    requests: [] as string[],
    versions,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      fixture.requests.push(url.href);
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      if (url.pathname.includes("/commits/"))
        return Response.json({ sha: fixture.commit, id: fixture.commit });
      const sha =
        url.hostname === "raw.githubusercontent.com"
          ? url.pathname.split("/")[3]
          : (url.searchParams.get("ref") ?? url.pathname.split("/").at(-1) ?? "");
      const files = versions.get(sha);
      if (url.pathname.includes("/git/trees/") || url.pathname.endsWith("/tree")) {
        const tree = [...(files ?? [])].map(([path, content]) => ({
          path,
          type: "blob",
          mode: "100644",
          sha: gitBlobHash(content),
          id: gitBlobHash(content),
          size: Buffer.byteLength(content),
        }));
        return url.hostname === "gitlab.com"
          ? Response.json(tree, { headers: { "x-next-page": "" } })
          : Response.json({ truncated: false, tree });
      }
      if (url.pathname.includes("/blobs/")) {
        const id = url.pathname.split("/").at(-2);
        for (const files of versions.values())
          for (const content of files.values())
            if (gitBlobHash(content) === id) return new Response(content);
      }
      const path = url.pathname.split("/").slice(4).map(decodeURIComponent).join("/");
      if (files?.has(path)) return new Response(files.get(path));
      return new Response("missing", { status: 404 });
    }) satisfies typeof fetch,
  };
  return fixture;
}
