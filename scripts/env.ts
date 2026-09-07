import { existsSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; run pnpm setup:local`);
  return value;
}
