import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Database } from "@platform/database";
import { createApp } from "../../apps/control-plane/src/app.ts";
import { Vault } from "../../apps/control-plane/src/infrastructure/crypto.ts";
import { Skills } from "../../apps/control-plane/src/modules/skills/skills.ts";
import { SkillSources } from "../../apps/control-plane/src/modules/skills/sources.ts";
import { Platform } from "../../apps/control-plane/src/platform.ts";
import type { Principal, SkillImportPreview } from "../../packages/contracts/src/index.ts";
import { required } from "../../scripts/env.ts";
import { standardSkill } from "../fixtures/skill-fixture.ts";
import { firstCommit, secondCommit, sourceFixture } from "../fixtures/skill-source-fixture.ts";

const schema = `test_skill_import_${process.pid}`,
  admin = new Database(required("DATABASE_URL")),
  db = new Database(required("DATABASE_URL"), schema);
const platform = new Platform(db, new Vault("ac".repeat(32))),
  fixture = sourceFixture(),
  skills = new Skills(db, platform.projects, "hosted-local", new SkillSources(fixture.fetch));
const { app } = createApp(platform, {
  origin: "http://console.test",
  runtimeToken: "test-runtime",
});
let owner: Principal,
  editor: Principal,
  other: Principal,
  projectId: string,
  secondProject: string,
  cookie: string;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await platform.initialize();
  await platform.identity.setup("imports_owner", "synthetic-password-123", "Skill import test");
  const session = await platform.identity.login("imports_owner", "synthetic-password-123");
  owner = await platform.identity.session(session);
  const response = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "imports_owner", password: "synthetic-password-123" }),
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  projectId = (await platform.projects.create(owner, { name: "Imports", description: "" })).id;
  secondProject = (await platform.projects.create(owner, { name: "Other", description: "" })).id;
  for (const name of ["editor", "other"]) {
    const invite = await platform.members.invite(owner, {
      label: name,
      projectId,
      projectRole: "editor",
    });
    await platform.members.join({
      token: invite.token,
      username: `import_${name}`,
      displayName: name,
      password: "synthetic-password-123",
    });
    const actor = await platform.identity.session(
      await platform.identity.login(`import_${name}`, "synthetic-password-123"),
    );
    if (name === "editor") editor = actor;
    else other = actor;
  }
});
after(async () => {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.close();
});
const remote = (commit = firstCommit) => ({
  kind: "remote" as const,
  source: { url: "owner/repo" },
  commit,
  path: "skills/report",
});

test("remote preview freezes reviewed content, is private, idempotent and imports no script authorization", async () => {
  const preview = await skills.preview(editor, projectId, remote());
  assert.equal(preview.baseVersion, null);
  assert.equal((await skills.list(editor, projectId)).items.length, 0);
  assert.deepEqual(preview.manifest.entrypoints, ["scripts/report.mjs"]);
  assert.deepEqual(preview.manifest.extensionFields, ["hooks", "model"]);
  await assert.rejects(skills.previewFile(other, projectId, preview.id, "SKILL.md"), {
    code: "SKILL_PREVIEW_UNAVAILABLE",
  });
  await assert.rejects(skills.confirmImport(owner, secondProject, preview.id), {
    code: "SKILL_PREVIEW_UNAVAILABLE",
  });
  const file = await skills.previewFile(editor, projectId, preview.id, "SKILL.md");
  assert.match(Buffer.from(file.contentBase64, "base64").toString(), /ONE/);
  fixture.commit = secondCommit;
  const count = fixture.requests.length;
  const [first, duplicate] = await Promise.all([
    skills.confirmImport(editor, projectId, preview.id),
    skills.confirmImport(editor, projectId, preview.id),
  ]);
  assert.equal(first.skill.id, duplicate.skill.id);
  assert.equal(fixture.requests.length, count, "confirmation must not re-fetch upstream");
  assert.equal(first.skill.version, 1);
  assert.equal(first.skill.source?.kind, "github");
  assert.equal(first.skill.source?.commit, firstCommit);
  assert.equal(first.skill.digest, preview.digest);
  assert.equal((await skills.file(editor, projectId, first.skill.id, "SKILL.md")).hash, file.hash);
  const model = await platform.resources.createModel(owner, projectId, {
    name: "Fixture",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:9999/v1",
    apiKey: "",
  });
  await assert.rejects(
    platform.agents.create(editor, projectId, {
      name: "Denied script",
      instructions: "Test",
      modelId: model.id,
      toolIds: [],
      skillBindings: [{ versionId: first.skill.id, entrypoints: ["scripts/report.mjs"] }],
    }),
    { code: "SKILL_AUTHORIZATION_REQUIRED" },
  );
  const agent = await platform.agents.create(owner, projectId, {
    name: "Pinned",
    instructions: "Test",
    modelId: model.id,
    toolIds: [],
    skillBindings: [{ versionId: first.skill.id, entrypoints: [] }],
  });
  const release = await platform.agents.publish(owner, projectId, agent.id, 1);
  const update = await skills.previewUpdate(editor, projectId, first.skill.id);
  assert.equal(update.baseVersion?.id, first.skill.id);
  assert.ok(update.changes.some((c) => c.kind === "removed" && c.path === "references/removed.md"));
  assert.ok(update.changes.some((c) => c.kind === "added" && c.path === "references/new.md"));
  assert.ok(update.changes.some((c) => c.kind === "modified" && c.path === "SKILL.md"));
  const v2 = await skills.confirmImport(editor, projectId, update.id);
  assert.equal(v2.skill.version, 2);
  const [storedRelease] = await db.query("SELECT snapshot FROM releases WHERE id=$1", [release.id]);
  assert.equal(Reflect.get(storedRelease.snapshot as object, "skills")[0].id, first.skill.id);
  const audits = await db.query(
    "SELECT details FROM access_audit WHERE action='skill.import' AND project_id=$1",
    [projectId],
  );
  assert.equal(audits.length, 2);
  assert.ok(JSON.stringify(audits).includes(secondCommit));
  assert.equal(JSON.stringify(audits).includes("console.log"), false);
});

test("stale or expired previews cannot silently override a newer import and disabled versions remain disabled", async () => {
  const stale = await skills.preview(owner, secondProject, {
    kind: "zip",
    fileName: "one.zip",
    archiveBase64: standardSkill("ONE"),
  });
  const two = await skills.upload(owner, secondProject, standardSkill("TWO"));
  await assert.rejects(skills.confirmImport(owner, secondProject, stale.id), {
    code: "SKILL_IMPORT_STALE",
  });
  const current = await skills.preview(owner, secondProject, {
    kind: "zip",
    fileName: "two.zip",
    archiveBase64: standardSkill("TWO"),
  });
  assert.equal(current.existingVersion?.id, two.id);
  await skills.setEnabled(owner, secondProject, two.id, false);
  const duplicate = await skills.confirmImport(owner, secondProject, current.id);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.skill.enabled, false);
  const expired = await skills.preview(owner, secondProject, {
    kind: "zip",
    fileName: "three.zip",
    archiveBase64: standardSkill("THREE"),
  });
  await db.query(
    "UPDATE skill_import_previews SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(skills.confirmImport(owner, secondProject, expired.id), {
    code: "SKILL_PREVIEW_UNAVAILABLE",
  });
  await assert.rejects(skills.previewUpdate(owner, secondProject, two.id), {
    code: "SKILL_SOURCE_MISSING",
  });
});

test("HTTP preview endpoints preserve DTO shapes and recheck membership before confirmation", async () => {
  const response = await app.request(`/api/v1/projects/${secondProject}/skills/previews`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "zip",
      archiveBase64: standardSkill("HTTP"),
      fileName: "http.zip",
    }),
  });
  assert.equal(response.status, 200);
  const preview: SkillImportPreview = await response.json();
  assert.equal(preview.source.kind, "zip");
  const content = await app.request(
    `/api/v1/projects/${secondProject}/skills/previews/${preview.id}/file?path=SKILL.md`,
    { headers: { cookie } },
  );
  assert.equal(content.status, 200);
  const confirmed = await app.request(
    `/api/v1/projects/${secondProject}/skills/previews/${preview.id}/confirm`,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" },
  );
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.skill.source.fileName, "http.zip");
  const staged = await skills.preview(editor, projectId, remote());
  await platform.members.setProjectMember(owner, projectId, editor.id, "viewer");
  await assert.rejects(skills.confirmImport(editor, projectId, staged.id), { code: "FORBIDDEN" });
  await assert.rejects(skills.previewFile(editor, projectId, staged.id, "SKILL.md"), {
    code: "FORBIDDEN",
  });
  await assert.rejects(skills.discover(editor, projectId, { url: "owner/repo" }), {
    code: "FORBIDDEN",
  });
  await platform.members.setProjectMember(owner, projectId, editor.id, "editor");
  const foreign: Principal = { ...owner, id: randomUUID(), tenantId: randomUUID() };
  await assert.rejects(skills.confirmImport(foreign, projectId, staged.id));
});
