import { existsSync } from "node:fs";

// `.env` holds shared local settings; `.env.runtime` extends it with
// machine-specific runtime values (sandbox images, workspace root).
// Both are loaded when present; values in the runtime file win.
const envFiles = [new URL("../.env", import.meta.url), new URL("../.env.runtime", import.meta.url)];
for (const envFile of envFiles) if (existsSync(envFile)) process.loadEnvFile(envFile);

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; run pnpm setup:local`);
  return value;
}
