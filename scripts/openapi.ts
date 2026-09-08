import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "@platform/database";
import { createApp } from "../apps/control-plane/src/app.ts";
import { Vault } from "../apps/control-plane/src/crypto.ts";
import { Store } from "../apps/control-plane/src/store.ts";

// Schema export builds route definitions only; it neither connects nor migrates the database.
const db = new Database("postgres://unused:unused@127.0.0.1:1/unused");
const { app } = createApp(new Store(db, new Vault("00".repeat(32))), {
  origin: "http://127.0.0.1:5173",
  runtimeToken: "schema-export-only",
});
const document = app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "Agent Platform API", version: "0.1.0" },
  servers: [{ url: "/" }],
});
const output = process.env.PLATFORM_OPENAPI_OUTPUT ?? "packages/contracts/openapi/platform.json";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
await db.close();
console.log("OpenAPI exported from control-plane routes.");
