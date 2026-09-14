import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { importSkillArchive } from "../../apps/control-plane/src/modules/skills/archive.ts";
import { prepareSkills, type SkillAccess } from "../../apps/runtime/src/skills/skills.ts";
import { SkillSnapshot } from "../../packages/contracts/src/skills.ts";
import { standardSkill } from "../fixtures/skill-fixture.ts";

async function fixture() {
  const archive = await importSkillArchive(standardSkill("PINNED"));
  const snapshot = SkillSnapshot.parse({
    ...archive.manifest,
    id: randomUUID(),
    projectId: randomUUID(),
    version: 3,
    digest: archive.digest,
    archiveHash: archive.archiveHash,
    createdAt: new Date().toISOString(),
    authorizedEntrypoints: [],
  });
  const operations: string[] = [];
  const access: SkillAccess = async (input) => {
    assert.equal(input.versionId, snapshot.id);
    operations.push(`${input.operation}:${input.path ?? ""}`);
    if (input.operation === "check") return {};
    assert.equal(input.operation, "read", "selection must never execute a script");
    const file = snapshot.files.find((f) => f.path === input.path);
    assert.ok(file);
    const bytes = archive.files.get(file.path);
    assert.ok(bytes);
    return { path: file.path, contentBase64: bytes.toString("base64"), hash: file.hash };
  };
  return { snapshot, access, operations };
}

test("explicit Skill selection provides the native activation instructions and package catalog from its pinned version", async () => {
  const { snapshot, access, operations } = await fixture();
  const prepared = await prepareSkills(
    [snapshot],
    access,
    new AbortController().signal,
    undefined,
    [snapshot.id],
  );
  try {
    const skill = await prepared.workspace?.skills?.get(snapshot.name);
    assert.ok(
      skill,
      "the workspace must initialize the selected Skill before its first model request",
    );
    assert.ok(prepared.instructions.includes(skill.instructions));
    assert.match(prepared.instructions, /Skill report-skill v3/);
    assert.match(prepared.instructions, /报表 Skill PINNED/);
    assert.match(prepared.instructions, /## Scripts\n- scripts\/report\.mjs/);
    assert.match(prepared.instructions, /## References\n- references\/rules\.md/);
    assert.doesNotMatch(prepared.instructions, /author: platform-test/);
    assert.deepEqual(prepared.tools, {}, "file discovery does not grant script execution");
    assert.equal(operations.filter((o) => o.startsWith("execute")).length, 0);
    assert.doesNotMatch(prepared.instructions, /金额使用输入值求和，不得编造结果/);
    assert.ok(operations.includes("read:SKILL.md"));
  } finally {
    prepared.close();
  }
});

test("unselected Skills remain discoverable without injecting their full instructions", async () => {
  const { snapshot, access } = await fixture();
  const prepared = await prepareSkills([snapshot], access, new AbortController().signal);
  try {
    assert.equal(prepared.instructions, "");
    assert.ok(await prepared.workspace?.skills?.get(snapshot.name));
  } finally {
    prepared.close();
  }
});

test("explicit activation rejects unavailable versions and altered package content", async () => {
  const { snapshot, access } = await fixture();
  const signal = new AbortController().signal;
  await assert.rejects(
    prepareSkills([snapshot], access, signal, undefined, [randomUUID()]),
    /SKILL_ACCESS_DENIED/,
  );
  await assert.rejects(
    prepareSkills(
      [snapshot],
      async () => {
        throw new Error("disabled");
      },
      signal,
      undefined,
      [snapshot.id],
    ),
    /SKILL_ACCESS_DENIED/,
  );
  await assert.rejects(
    prepareSkills(
      [snapshot],
      async (input, signal) => {
        const value = await access(input, signal);
        return input.operation === "read"
          ? { ...Object(value), contentBase64: Buffer.from("altered").toString("base64") }
          : value;
      },
      signal,
      undefined,
      [snapshot.id],
    ),
    /SKILL_CONTENT_INVALID/,
  );
});

test("native activation hooks reuse loaded instructions, record successful model activation and recheck revocation", async () => {
  const { snapshot, access } = await fixture();
  const loaded: { source: string; versionId: string }[] = [];
  let revoked = false;
  const prepared = await prepareSkills(
    [snapshot],
    async (input, signal) => {
      if (revoked) throw new Error("SKILL_ACCESS_DENIED");
      return access(input, signal);
    },
    new AbortController().signal,
    undefined,
    [snapshot.id],
    async (event) => {
      loaded.push(event);
    },
  );
  const call = {
    toolName: "skill",
    input: { name: snapshot.name },
    context: { agent: { toolCallId: "call-1" } },
  };
  try {
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].source, "selected");
    const skipped = await prepared.hooks.beforeToolCall?.(call);
    assert.equal(skipped?.proceed, false);
    assert.match(String(skipped?.output), /已在本轮加载/);
    assert.doesNotMatch(String(skipped?.output), /报表 Skill PINNED/);
    revoked = true;
    await assert.rejects(async () => prepared.hooks.beforeToolCall?.(call), /SKILL_ACCESS_DENIED/);
  } finally {
    prepared.close();
  }
});
