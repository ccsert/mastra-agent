import { createRoute } from "@hono/zod-openapi";
import { RuntimeInfo, z } from "@platform/contracts";
import { type ApiApp, errors, json } from "../../http/contracts.ts";
import type { Runtimes } from "./runtimes.ts";
export function registerRuntimeRoutes(app: ApiApp, runtimes: Runtimes) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/runtimes",
      operationId: "listRuntimes",
      responses: { 200: json(z.array(RuntimeInfo)), ...errors },
    }),
    async (c) => c.json(await runtimes.list(c.get("principal")), 200),
  );
}
