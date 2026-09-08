import { createRoute } from "@hono/zod-openapi";
import { Principal, z } from "@platform/contracts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ApiError } from "./errors.ts";
import type { Identity } from "./identity.ts";

const loginInput = z
  .object({
    username: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{3,50}$/),
    password: z.string().min(12).max(200),
  })
  .strict();

import { type ApiApp, body, errors, json } from "./http.ts";
export function registerIdentityRoutes(app: ApiApp, identity: Identity, secureCookie = false) {
  const authTimes: number[] = [];
  app.use("/api/v1/auth/*", async (c, next) => {
    if (c.req.method === "POST") {
      const now = Date.now();
      while (authTimes[0] < now - 60000) authTimes.shift();
      if (authTimes.length >= 20)
        throw new ApiError(429, "RATE_LIMITED", "尝试次数过多，请稍后重试");
      authTimes.push(now);
    }
    await next();
  });
  const cookie = (c: Parameters<typeof setCookie>[0], token: string) =>
    setCookie(c, "platform_session", token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: secureCookie,
      path: "/",
      maxAge: 43200,
    });
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/auth/status",
      operationId: "getSetupStatus",
      responses: { 200: json(z.object({ initialized: z.boolean() })), ...errors },
    }),
    async (c) => c.json({ initialized: await identity.isSetup() }, 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/setup",
      operationId: "setupPlatform",
      request: {
        body: body(loginInput.extend({ workspaceName: z.string().trim().min(1).max(80) })),
      },
      responses: { 200: json(Principal), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      await identity.setup(input.username, input.password, input.workspaceName);
      const token = await identity.login(input.username, input.password);
      cookie(c, token);
      return c.json(await identity.session(token), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/login",
      operationId: "login",
      request: { body: body(loginInput) },
      responses: { 200: json(Principal), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json"),
        token = await identity.login(input.username, input.password);
      cookie(c, token);
      return c.json(await identity.session(token), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/logout",
      operationId: "logout",
      request: { body: body(z.object({}).strict()) },
      responses: { 200: json(z.object({ ok: z.boolean() })), ...errors },
    }),
    async (c) => {
      await identity.logout(getCookie(c, "platform_session") ?? "");
      deleteCookie(c, "platform_session", { path: "/" });
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me",
      operationId: "getCurrentUser",
      responses: { 200: json(Principal), ...errors },
    }),
    (c) => c.json(c.get("principal"), 200),
  );
}
