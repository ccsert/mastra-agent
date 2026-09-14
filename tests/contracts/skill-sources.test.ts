import assert from "node:assert/strict";
import { test } from "node:test";
import { importSkillArchive } from "../../apps/control-plane/src/modules/skills/archive.ts";
import {
  parseSkillSource,
  SkillSources,
} from "../../apps/control-plane/src/modules/skills/sources.ts";
import { skillDoc, skillZip } from "../fixtures/skill-fixture.ts";
import { firstCommit, sourceFixture } from "../fixtures/skill-source-fixture.ts";

test("GitHub, skills.sh and GitLab sources resolve namespaces, names, refs and subdirectories", async () => {
  assert.equal(parseSkillSource({ url: "owner/repo" }).source.repository, "owner/repo");
  assert.equal(parseSkillSource({ url: "owner/repo@report-skill" }).selector, "report-skill");
  assert.deepEqual(
    parseSkillSource({ url: "https://gitlab.com/org/group/repo/-/tree/main/skills/report" }).source,
    {
      kind: "gitlab",
      url: "https://gitlab.com/org/group/repo",
      repository: "org/group/repo",
      ref: "main",
      commit: "",
      path: "skills/report",
    },
  );
  assert.equal(
    parseSkillSource({
      url: "https://github.com/owner/repo",
      ref: "feature/docs",
      path: "skills/report",
    }).source.ref,
    "feature/docs",
  );
  const fixture = sourceFixture(),
    sources = new SkillSources(fixture.fetch);
  const all = await sources.discover({ url: "owner/repo" });
  assert.equal(all.candidates.length, 2);
  assert.equal(all.source.commit, firstCommit);
  const selected = await sources.discover({ url: "https://skills.sh/owner/repo/report-skill" });
  assert.deepEqual(
    selected.candidates.map((c) => c.path),
    ["skills/report"],
  );
  const read = await sources.read({ url: "owner/repo" }, all.source.commit, "skills/report");
  assert.equal(read.pkg.manifest.name, "report-skill");
  assert.equal(read.pkg.manifest.files.length, 3);
  assert.deepEqual(read.pkg.manifest.extensionFields, ["hooks", "model"]);
  assert.ok(read.pkg.manifest.warnings.some((w) => w.includes("不会应用")));
  assert.equal(read.source.path, "skills/report");
  const lab = await sources.discover({ url: "https://gitlab.com/org/group/repo" });
  const labRead = await sources.read({ url: lab.source.url }, lab.source.commit, "skills/report");
  assert.equal(labRead.pkg.digest, read.pkg.digest);
  assert.equal(labRead.source.kind, "gitlab");
});

test("untrusted source addresses cannot select arbitrary hosts, credentials or traversal paths", () => {
  for (const url of [
    "http://github.com/owner/repo",
    "https://127.0.0.1/private",
    "https://github.com.evil.test/owner/repo",
    "https://user:pass@github.com/owner/repo",
    "https://github.com:8443/owner/repo",
    "https://github.com/owner/../repo",
    "https://github.com/owner/%2e%2e/repo",
    "https://github.com/owner/repo?token=secret",
    "https://github.com/owner/repo#secret",
    "file:///tmp/skill",
    "npx skills add owner/repo; touch /tmp/unsafe",
  ])
    assert.throws(() => parseSkillSource({ url }), { code: "SKILL_SOURCE_INVALID" });
  assert.throws(() => parseSkillSource({ url: "owner/repo", path: "../escape" }), {
    code: "SKILL_SOURCE_INVALID",
  });
  assert.throws(() => parseSkillSource({ url: "owner/repo", ref: ".." }), {
    code: "SKILL_SOURCE_INVALID",
  });
});

test("redirects, truncated trees, missing files, LFS, bad hashes and links never produce partial packages", async () => {
  for (const status of [302, 403, 429]) {
    let requests = 0;
    const sources = new SkillSources(async () => {
      requests++;
      return new Response("", { status, headers: { location: "http://127.0.0.1/secret" } });
    });
    await assert.rejects(sources.discover({ url: "owner/repo" }));
    assert.equal(requests, 1);
  }
  const fixture = sourceFixture();
  for (const mode of ["truncated", "link", "hash", "oversize"]) {
    const sources = new SkillSources(async (input, init) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        const response = await fixture.fetch(input, init),
          value = await response.json();
        if (mode === "truncated") value.truncated = true;
        if (mode === "link") value.tree[1].mode = "120000";
        if (mode === "oversize") value.tree[1].size = 2097153;
        return Response.json(value);
      }
      if (mode === "hash" && url.includes("raw.githubusercontent.com"))
        return new Response("tampered");
      return fixture.fetch(input, init);
    });
    await assert.rejects(sources.read({ url: "owner/repo" }, firstCommit, "skills/report"), {
      code: "SKILL_SOURCE_INVALID",
    });
  }
  await assert.rejects(
    new SkillSources(fixture.fetch).read(
      { url: "https://github.com/owner/repo/tree/main/skills/guide" },
      firstCommit,
      "skills/report",
    ),
    { code: "SKILL_SOURCE_INVALID" },
  );
});

test("extension fields remain byte-identical and do not enter runtime configuration", async () => {
  const doc = skillDoc().replace(
    "metadata:",
    "context: fork\nagent: anything\nallowed-tools: Bash WebFetch\nmetadata:",
  );
  const pkg = await importSkillArchive(skillZip([{ path: "SKILL.md", content: doc }]));
  assert.equal(pkg.files.get("SKILL.md")?.toString(), doc);
  assert.deepEqual(pkg.manifest.extensionFields, ["agent", "context"]);
  assert.equal(Reflect.get(pkg.manifest, "agent"), undefined);
  assert.ok(pkg.manifest.warnings.some((w) => w.includes("allowed-tools")));
});

test("a skills.sh preview must match its advertised Skill and LFS pointers require actual content", async () => {
  const fixture = sourceFixture(),
    sources = new SkillSources(fixture.fetch);
  await assert.rejects(
    sources.read({ url: "https://skills.sh/owner/repo/report-skill" }, firstCommit, "skills/guide"),
    { code: "SKILL_SOURCE_INVALID" },
  );
  fixture.versions
    .get(firstCommit)
    ?.set(
      "skills/report/references/removed.md",
      "version https://git-lfs.github.com/spec/v1\noid sha256:example\nsize 42\n",
    );
  await assert.rejects(sources.read({ url: "owner/repo" }, firstCommit, "skills/report"), {
    code: "SKILL_SOURCE_INVALID",
  });
  const missing = new SkillSources(async (input, init) =>
    String(input).includes("raw.githubusercontent.com")
      ? new Response("missing", { status: 404 })
      : fixture.fetch(input, init),
  );
  await assert.rejects(missing.read({ url: "owner/repo" }, firstCommit, "skills/report"), {
    code: "SKILL_SOURCE_INVALID",
  });
});
