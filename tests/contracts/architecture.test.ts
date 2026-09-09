import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
async function check(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "platform-architecture-"));
  try {
    for (const [name, source] of Object.entries({
      "tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler","module":"ESNext"}}',
      ...files,
    })) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), source);
    }
    try {
      const result = await exec(
        join(root, "node_modules/.bin/depcruise"),
        ["--config", join(root, ".dependency-cruiser.cjs"), "--output-type", "json", "apps"],
        { cwd: dir, maxBuffer: 1048576 },
      );
      return JSON.parse(result.stdout).summary.violations as { rule: { name: string } }[];
    } catch (error) {
      assert.ok(error && typeof error === "object" && "stdout" in error);
      return JSON.parse(String(error.stdout)).summary.violations as { rule: { name: string } }[];
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const allowed = {
  "apps/console/src/features/agents/internal.ts": "export const agent=1; export type Agent=number;",
  "apps/console/src/features/agents/index.ts":
    "export { agent } from './internal';export type {Agent} from './internal';",
  "apps/console/src/app/App.ts":
    "import { agent } from '../features/agents/index'; export { agent };",
  "apps/control-plane/src/modules/skills/internal.ts": "export const skill=1;",
  "apps/control-plane/src/modules/skills/index.ts": "export {skill} from './internal';",
  "apps/control-plane/src/modules/skills/routes.ts": "export const routes=1;",
  "apps/control-plane/src/app.ts":
    "import {routes} from './modules/skills/routes';export {routes};",
  "apps/control-plane/src/platform.ts": "export type Platform=number;",
  "apps/control-plane/src/http/contracts.ts": "export type Http=number;",
  "apps/control-plane/src/modules/agents/agents.ts":
    "import {skill} from '../skills/index';export {skill};",
  "apps/runtime/src/skills/internal.ts": "export const run=1;",
  "apps/runtime/src/skills/index.ts": "export {run} from './internal';",
  "apps/runtime/src/agents/execute.ts": "import {run} from '../skills/index';export {run};",
};
test("module checks accept public imports, internal composition and root route registration", async () => {
  assert.deepEqual(await check(allowed), []);
});
test("module checks reject private imports including type-only access and reverse dependencies", async () => {
  const violations = await check({
    ...allowed,
    "apps/console/src/features/skills/bypass.ts":
      "import type {Agent} from '../agents/internal';export type Value=Agent;",
    "apps/console/src/shared/reverse.ts":
      "import {agent} from '../features/agents/index';export {agent};",
    "apps/console/src/features/skills/reverse.ts":
      "import {agent} from '../../app/App';export {agent};",
    "apps/control-plane/src/modules/agents/bypass.ts":
      "import {skill} from '../skills/internal';import type {Platform} from '../../platform';import type {Http} from '../../http/contracts';export {skill};export type Value=[Platform,Http];",
    "apps/control-plane/src/modules/agents/route-bypass.ts":
      "import {routes} from '../skills/routes';export {routes};",
    "apps/runtime/src/agents/bypass.ts": "import {run} from '../skills/internal';export {run};",
  });
  const names = new Set(violations.map((v) => v.rule.name));
  for (const rule of [
    "apps-console-src-features-agents-public-entry",
    "console-shared-does-not-depend-on-features",
    "console-features-do-not-depend-on-app",
    "apps-control-plane-src-modules-skills-public-entry",
    "domains-do-not-import-composition-root",
    "domain-implementation-does-not-depend-on-http",
    "only-composition-registers-domain-routes",
    "apps-runtime-src-skills-public-entry",
  ])
    assert.ok(names.has(rule), `Missing protection: ${rule}`);
});
