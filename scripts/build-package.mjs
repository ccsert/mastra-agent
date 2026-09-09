import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Removing/renaming source modules must also remove obsolete JavaScript and declarations.
if (!existsSync("tsconfig.build.json")) throw new Error("Run from a buildable workspace package");
rmSync(resolve("dist"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
    "-p",
    "tsconfig.build.json",
  ],
  { stdio: "inherit" },
);
