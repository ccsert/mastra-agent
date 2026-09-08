import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (!existsSync(".env")) {
  const password = randomBytes(24).toString("hex");
  writeFileSync(
    ".env",
    `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgres://agent_platform:${password}@127.0.0.1:5442/agent_platform\nENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nRUNTIME_TOKEN=${randomBytes(32).toString("hex")}\nRUNTIME_ID=hosted-local\nCONTROL_PLANE_URL=http://127.0.0.1:4110\nCONSOLE_ORIGIN=http://127.0.0.1:5179\nCONSOLE_HOST=0.0.0.0\nCONSOLE_PORT=5179\nAPI_PORT=4110\nRUNTIME_PORT=4112\n`,
    { mode: 0o600, flag: "wx" },
  );
}
process.loadEnvFile(".env");
if (!existsSync(".env.runtime")) {
  const keys = ["CONTROL_PLANE_URL", "RUNTIME_TOKEN", "RUNTIME_ID", "RUNTIME_PORT"];
  writeFileSync(
    ".env.runtime",
    `${keys.map((key) => `${key}=${process.env[key] ?? ""}`).join("\n")}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
mkdirSync(".local", { recursive: true });
console.log(
  "Local configuration is ready in .env. Run docker compose up -d postgres, then pnpm db:migrate and pnpm dev.",
);
