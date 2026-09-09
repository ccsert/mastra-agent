import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { runSkillSandbox } from "../../apps/runtime/src/skills/sandbox.ts";

const exec = promisify(execFile),
  image = process.env.SKILL_TEST_IMAGE;
const docker = async (args: string[]) =>
  (await exec("docker", args, { timeout: 10000 })).stdout.trim();
const run = (
  path: string,
  script: string,
  input: Record<string, unknown> = {},
  signal = AbortSignal.timeout(40000),
) => runSkillSandbox({ image, path, files: new Map([[path, Buffer.from(script)]]), input, signal });
test("Docker Skill execution enforces readonly packages, network isolation and no host credentials; Node/Python/Bash work", {
  skip: !image,
  timeout: 30000,
}, async () => {
  const previous = process.env.SKILL_HOST_CANARY;
  process.env.SKILL_HOST_CANARY = "host-only-test-secret";
  try {
    const probe = await run(
      "scripts/probe.mjs",
      `import fs from 'node:fs'; import os from 'node:os'; const errors={}; for(const p of ['/skill/scripts/probe.mjs','/etc/forbidden'])try{fs.writeFileSync(p,'no')}catch(e){errors[p]=e.code}try{fs.statSync('/var/run/docker.sock')}catch(e){errors.socket=e.code}console.log(JSON.stringify({uid:process.getuid(),errors,net:Object.keys(os.networkInterfaces()),canary:process.env.SKILL_HOST_CANARY??null}));`,
    );
    const observed = JSON.parse(probe.stdout);
    assert.equal(observed.uid, 1000);
    assert.deepEqual(observed.net, ["lo"]);
    assert.equal(observed.canary, null);
    assert.equal(observed.errors.socket, "ENOENT");
    assert.equal(observed.errors["/skill/scripts/probe.mjs"], "EROFS");
    assert.equal(observed.errors["/etc/forbidden"], "EROFS");
    const [one, two] = await Promise.all([
      run("scripts/a.py", `import sys,json\nv=json.load(sys.stdin)\nprint(v['token'])`, {
        token: "tenant-one",
      }),
      run("scripts/b.sh", `#!/bin/bash\nread -r value\nprintf '%s\\n' "$value"`, {
        token: "tenant-two",
      }),
    ]);
    assert.equal(one.stdout.trim(), "tenant-one");
    assert.deepEqual(JSON.parse(two.stdout), { token: "tenant-two" });
    const unicode = await run(
      "scripts/unicode.mjs",
      `for (const byte of Buffer.from('订单🧩')) { process.stdout.write(Buffer.from([byte])); process.stderr.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 80)); }`,
    );
    assert.equal(unicode.stdout, "订单🧩");
    assert.equal(unicode.stderr, "订单🧩");
  } finally {
    if (previous === undefined) delete process.env.SKILL_HOST_CANARY;
    else process.env.SKILL_HOST_CANARY = previous;
  }
});
test("output overflow and cancellation kill the container process tree and remove its private volume", {
  skip: !image,
  timeout: 25000,
}, async () => {
  await assert.rejects(
    run("scripts/loud.mjs", `console.log('x'.repeat(200000));setInterval(()=>{},1000)`),
    /SKILL_OUTPUT_LIMIT/,
  );
  const before = new Set(
    (
      await docker(["ps", "-aq", "--filter", "label=agent-platform.component=skill-execution"])
    ).split("\n"),
  );
  const stop = new AbortController();
  const task = run(
    "scripts/child.mjs",
    `import {spawn} from 'node:child_process';spawn('/bin/bash',['-c','sleep 1000']);setInterval(()=>{},1000)`,
    {},
    stop.signal,
  );
  // Attach a rejection handler immediately while waiting for the actual container to be running.
  const result = task.then(
    () => undefined,
    (error: unknown) => error,
  );
  let id = "",
    name = "";
  try {
    for (let i = 0; i < 80; i++) {
      const ids = (
        await docker(["ps", "-q", "--filter", "label=agent-platform.component=skill-execution"])
      )
        .split("\n")
        .filter((v) => v && !before.has(v));
      for (const candidate of ids) {
        const [state] = JSON.parse(await docker(["inspect", candidate]));
        if (state.Args.includes("/skill/scripts/child.mjs")) {
          id = candidate;
          name = String(state.Name).slice(1);
          break;
        }
      }
      if (id) break;
      await new Promise((r) => setTimeout(r, 75));
    }
    assert.ok(id, "the script must actually start before cancellation");
    let processes = "";
    for (let i = 0; i < 30; i++) {
      processes = await docker(["top", id, "-eo", "pid,ppid,args"]);
      if (processes.includes("sleep 1000")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(processes, /sleep 1000/);
  } finally {
    stop.abort(new Error("CANCELLED"));
  }
  const error = await result;
  assert.ok(error instanceof Error);
  assert.equal(error.message, "CANCELLED");
  assert.equal(await docker(["ps", "-aq", "--filter", `name=^/${name}$`]), "");
  assert.equal(await docker(["volume", "ls", "-q", "--filter", `name=^${name}-package$`]), "");
  assert.equal((await run("scripts/after.mjs", `console.log('clean')`)).stdout.trim(), "clean");
});
test("missing fixed sandbox configuration never falls back to host execution", async () => {
  await assert.rejects(
    runSkillSandbox({
      image: undefined,
      path: "scripts/a.sh",
      files: new Map([["scripts/a.sh", Buffer.from("exit 0")]]),
      input: {},
      signal: new AbortController().signal,
    }),
    /SKILL_SANDBOX_UNAVAILABLE/,
  );
});
