import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// A new destination prevents accidental replacement of an installed release.
const root = resolve(process.argv[2] ?? `output/release-${Date.now()}`);
if (existsSync(root)) throw new Error("Bundle destination already exists; choose a new directory");
await mkdir(root, { recursive: true });
for (const service of ["control-plane", "runtime"]) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      `@platform/${service}`,
      "deploy",
      "--prod",
      "--legacy",
      "--frozen-lockfile",
      "--config.hoist=false",
      resolve(root, service),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Service bundles: ${root}`);
