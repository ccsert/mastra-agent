import { createRoute } from "@hono/zod-openapi";
import {
  AuditEntry,
  Id,
  Invitation,
  InvitationCreated,
  InvitationInput,
  MemberUpdate,
  ProjectAccess,
  ProjectMember,
  ProjectRole,
  TeamMember,
  z,
} from "@platform/contracts";
import {
  type ApiApp,
  body,
  errors,
  itemParams,
  json,
  projectParams,
} from "../../http/contracts.ts";
import type { Access } from "../access/index.ts";
import type { Members } from "./members.ts";

const ok = z.object({ ok: z.boolean() });
const idParams = z.object({ id: Id });
export function registerMemberRoutes(app: ApiApp, members: Members, access: Access) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/team/members",
      operationId: "listTeamMembers",
      responses: { 200: json(z.array(TeamMember)), ...errors },
    }),
    async (c) => c.json(await members.list(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/team/members/{id}",
      operationId: "updateTeamMember",
      request: { params: idParams, body: body(MemberUpdate) },
      responses: { 200: json(TeamMember), ...errors },
    }),
    async (c) =>
      c.json(
        await members.update(c.get("principal"), c.req.valid("param").id, c.req.valid("json")),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/team/members/{id}/revoke-sessions",
      operationId: "revokeMemberSessions",
      request: { params: idParams, body: body(z.object({}).strict()) },
      responses: { 200: json(ok), ...errors },
    }),
    async (c) => {
      await members.revokeSessions(c.get("principal"), c.req.valid("param").id);
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/team/transfer-owner",
      operationId: "transferTeamOwner",
      request: { body: body(z.object({ userId: Id }).strict()) },
      responses: { 200: json(ok), ...errors },
    }),
    async (c) => {
      await members.transfer(c.get("principal"), c.req.valid("json").userId);
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/access",
      operationId: "getProjectAccess",
      request: { params: projectParams },
      responses: { 200: json(ProjectAccess), ...errors },
    }),
    async (c) =>
      c.json(await access.project(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/members/candidates",
      operationId: "findProjectMemberCandidates",
      request: { params: projectParams, query: z.object({ q: z.string().max(80).default("") }) },
      responses: { 200: json(z.array(TeamMember)), ...errors },
    }),
    async (c) =>
      c.json(
        await members.candidates(
          c.get("principal"),
          c.req.valid("param").projectId,
          c.req.valid("query").q,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/members",
      operationId: "listProjectMembers",
      request: { params: projectParams },
      responses: { 200: json(z.array(ProjectMember)), ...errors },
    }),
    async (c) =>
      c.json(await members.projectMembers(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/projects/{projectId}/members/{id}",
      operationId: "setProjectMember",
      request: {
        params: itemParams,
        body: body(z.object({ role: z.union([ProjectRole, z.null()]) }).strict()),
      },
      responses: { 200: json(ok), ...errors },
    }),
    async (c) => {
      const { projectId, id } = c.req.valid("param");
      await members.setProjectMember(c.get("principal"), projectId, id, c.req.valid("json").role);
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/invitations",
      operationId: "createInvitation",
      request: { body: body(InvitationInput) },
      responses: { 200: json(InvitationCreated), ...errors },
    }),
    async (c) => c.json(await members.invite(c.get("principal"), c.req.valid("json")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/team/invitations",
      operationId: "listTeamInvitations",
      responses: { 200: json(z.array(Invitation)), ...errors },
    }),
    async (c) => c.json(await members.invitations(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/invitations",
      operationId: "listProjectInvitations",
      request: { params: projectParams },
      responses: { 200: json(z.array(Invitation)), ...errors },
    }),
    async (c) =>
      c.json(await members.invitations(c.get("principal"), c.req.valid("param").projectId), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/invitations/{id}/revoke",
      operationId: "revokeInvitation",
      request: { params: idParams, body: body(z.object({}).strict()) },
      responses: { 200: json(ok), ...errors },
    }),
    async (c) => {
      await members.revokeInvitation(c.get("principal"), c.req.valid("param").id);
      return c.json({ ok: true }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/team/audit",
      operationId: "listTeamAudit",
      responses: { 200: json(z.array(AuditEntry)), ...errors },
    }),
    async (c) => c.json(await members.audit(c.get("principal")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/projects/{projectId}/audit",
      operationId: "listProjectAudit",
      request: { params: projectParams },
      responses: { 200: json(z.array(AuditEntry)), ...errors },
    }),
    async (c) =>
      c.json(await members.audit(c.get("principal"), c.req.valid("param").projectId), 200),
  );
}
