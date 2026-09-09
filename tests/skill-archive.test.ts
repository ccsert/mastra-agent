import assert from "node:assert/strict";
import { test } from "node:test";
import { importSkillArchive } from "../apps/control-plane/src/skill-archive.ts";
import { skillDoc, skillZip, standardSkill } from "./skill-fixture.ts";

test("standard Skill archives preserve metadata, optional resources, Unicode names and immutable file digests", async () => {
  const imported = await importSkillArchive(standardSkill());
  assert.equal(imported.manifest.name, "report-skill");
  assert.equal(imported.manifest.files.length, 3);
  assert.deepEqual(imported.manifest.entrypoints, ["scripts/report.mjs"]);
  assert.equal(imported.manifest.metadata.author, "platform-test");
  const root = await importSkillArchive(
    skillZip([...imported.files].map(([path, content]) => ({ path, content }))),
  );
  assert.equal(root.digest, imported.digest);
  assert.notEqual(root.archiveHash, imported.archiveHash);
  assert.notEqual((await importSkillArchive(standardSkill("TWO"))).digest, root.digest);
  const unicode = await importSkillArchive(
    skillZip([{ path: "SKILL.md", content: skillDoc().replace("report-skill", "报表助手") }]),
  );
  assert.equal(unicode.manifest.name, "报表助手");
});
test("archive import rejects traversal, links, duplicate paths, bombs, invalid metadata and ambiguous roots", async () => {
  const valid = { path: "SKILL.md", content: skillDoc() };
  const cases = [
    [valid, { path: "../escape", content: "x" }],
    [valid, { path: "a\\b", content: "x" }],
    [valid, { path: "secret", content: "/etc/passwd", mode: 0o120777 }],
    [valid, valid],
    [
      valid,
      { path: "References/one.md", content: "x" },
      { path: "references/two.md", content: "y" },
    ],
    [valid, { path: "assets/é.txt", content: "x" }, { path: "assets/e\u0301.txt", content: "y" }],
    [valid, { path: "large", content: "x".repeat(2097153) }],
    [valid, { path: "folder", content: "x" }, { path: "folder/file", content: "x" }],
    [{ path: "wrong/SKILL.md", content: skillDoc() }],
    [{ path: "SKILL.md", content: skillDoc().replace("author: platform-test", "author: 23") }],
    [
      {
        path: "SKILL.md",
        content: skillDoc().replace("name: report-skill", "name: Invalid--Name"),
      },
    ],
    [
      {
        path: "SKILL.md",
        content: skillDoc().replace("metadata:", "metadata: &shared\n  self: *shared\nother:"),
      },
    ],
    [
      {
        path: "SKILL.md",
        content: skillDoc().replace("description:", "name: duplicate\ndescription:"),
      },
    ],
    [
      { path: "one/SKILL.md", content: skillDoc() },
      { path: "two/SKILL.md", content: skillDoc() },
    ],
  ];
  for (const entries of cases)
    await assert.rejects(
      importSkillArchive(skillZip(entries)),
      { code: "SKILL_PACKAGE_INVALID" },
      entries.map((e) => e.path).join(","),
    );
});
