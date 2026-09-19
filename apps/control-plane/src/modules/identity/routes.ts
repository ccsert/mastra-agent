import { createRoute } from "@hono/zod-openapi";
import { JoinInput, Principal, z } from "@platform/contracts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ApiError } from "../../infrastructure/errors.ts";
import type { Members } from "../members/index.ts";
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

import { type ApiApp, body, errors, json } from "../../http/contracts.ts";
export function registerIdentityRoutes(
  app: ApiApp,
  identity: Identity,
  secureCookie = false,
  members?: Members,
) {
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
      method: "post",
      path: "/api/v1/auth/join",
      operationId: "acceptInvitation",
      request: { body: body(JoinInput) },
      responses: { 200: json(Principal), ...errors },
    }),
    async (c) => {
      if (!members) throw new ApiError(503, "UNAVAILABLE", "成员服务暂不可用");
      const input = c.req.valid("json");
      await members.join(input);
      const token = await identity.login(input.username, input.password);
      cookie(c, token);
      return c.json(await identity.session(token), 200);
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
  const passwordChange = z
    .object({
      currentPassword: z.string().min(12).max(200),
      newPassword: z.string().min(12).max(200),
    })
    .strict();
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/me/password",
      operationId: "changePassword",
      request: { body: body(passwordChange) },
      responses: {
        200: json(z.object({ ok: z.boolean(), revokedSessions: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      if (principal.kind !== "user")
        throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用身份没有登录密码");
      const input = c.req.valid("json");
      const result = await identity.changePassword(
        principal,
        input.currentPassword,
        input.newPassword,
        getCookie(c, "platform_session") ?? "",
      );
      return c.json({ ok: true, revokedSessions: result.revoked }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/me/sessions/revoke-others",
      operationId: "revokeMyOtherSessions",
      request: { body: body(z.object({}).strict()) },
      responses: {
        200: json(z.object({ ok: z.boolean(), revoked: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      if (principal.kind !== "user")
        throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用身份没有登录会话");
      const result = await identity.revokeOtherSessions(
        principal,
        getCookie(c, "platform_session") ?? "",
      );
      return c.json({ ok: true, revoked: result.revoked }, 200);
    },
  );
}
