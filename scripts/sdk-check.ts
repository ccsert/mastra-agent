import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "platform-sdk-"));
function files(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = join(dir, item.name),
        key = prefix + item.name;
      return item.isDirectory()
        ? Object.entries(files(path, `${key}/`))
        : [[key, readFileSync(path, "utf8")]];
    }),
  );
}
try {
  const env = {
    ...process.env,
    PLATFORM_OPENAPI_OUTPUT: join(temp, "platform.json"),
    PLATFORM_SDK_OUTPUT: join(temp, "sdk"),
  };
  execFileSync("pnpm", ["sdk:generate"], { env, stdio: "pipe" });
  const schema = readFileSync("packages/contracts/openapi/platform.json", "utf8");
  if (schema !== readFileSync(env.PLATFORM_OPENAPI_OUTPUT, "utf8"))
    throw new Error("OpenAPI drift; run pnpm sdk:generate");
  const expected = files("packages/sdk/src/generated"),
    actual = files(env.PLATFORM_SDK_OUTPUT);
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Generated SDK drift; run pnpm sdk:generate");
  console.log("OpenAPI and SDK match the route contracts.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
