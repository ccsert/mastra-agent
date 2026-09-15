import { createRoute } from "@hono/zod-openapi";
import {
  RuntimeInfo,
  RuntimeRegistered,
  RuntimeRegisterInput,
  RuntimeUpdateInput,
  z,
} from "@platform/contracts";
import { type ApiApp, body, errors, json } from "../../http/contracts.ts";
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
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/runtimes",
      operationId: "registerRuntime",
      request: { body: body(RuntimeRegisterInput) },
      responses: { 200: json(RuntimeRegistered), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      return c.json(
        await runtimes.register(principal, c.req.valid("json") as { name: string }),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/runtimes/{id}",
      operationId: "updateRuntime",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: body(RuntimeUpdateInput),
      },
      responses: { 200: json(RuntimeInfo), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      return c.json(await runtimes.update(principal, id, c.req.valid("json")), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/runtimes/{id}",
      operationId: "deleteRuntime",
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: body(z.object({}).strict()),
      },
      responses: { 200: json(z.object({ ok: z.boolean() })), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { id } = c.req.valid("param");
      await runtimes.delete(principal, id);
      return c.json({ ok: true }, 200);
    },
  );
}
