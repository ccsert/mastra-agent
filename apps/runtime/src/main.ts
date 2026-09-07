import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const runtimeEnv =
  process.env.RUNTIME_ENV_FILE ?? fileURLToPath(new URL("../../../.env.runtime", import.meta.url));
if (existsSync(runtimeEnv)) process.loadEnvFile(runtimeEnv);
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing Runtime setting: ${name}`);
  return value;
}

import { runWorker } from "./worker.ts";

const controller = new AbortController();
const server = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ status: "ok", runtimeId: process.env.RUNTIME_ID ?? "hosted-local" }),
  );
});
server.listen(
  Number(process.env.RUNTIME_PORT ?? 4112),
  process.env.RUNTIME_HOST ?? "127.0.0.1",
  () => console.log("Runtime health endpoint ready; waiting for assigned jobs."),
);
const worker = runWorker({
  controlPlaneUrl: required("CONTROL_PLANE_URL"),
  runtimeToken: required("RUNTIME_TOKEN"),
  runtimeId: process.env.RUNTIME_ID ?? "hosted-local",
  signal: controller.signal,
});
async function stop() {
  controller.abort();
  server.close();
  await worker;
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
