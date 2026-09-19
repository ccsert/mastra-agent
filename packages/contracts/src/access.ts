import { Id, z } from "./common.ts";

export const TenantRole = z.enum(["owner", "admin", "member"]).openapi("TenantRole");
export const ProjectRole = z.enum(["admin", "editor", "member", "viewer"]).openapi("ProjectRole");
export const Permission = z
  .enum([
    "project.read",
    "project.manage",
    "agent.edit",
    "agent.publish",
    "agent.run",
    "resource.read",
    "resource.edit",
    "resource.manage",
  ])
  .openapi("Permission");
export type Permission = z.infer<typeof Permission>;
export const ProjectAccess = z
  .object({
    projectId: Id,
    role: z.union([ProjectRole, z.null()]),
    tenantRole: TenantRole.nullable(),
    permissions: z.array(Permission),
    archived: z.boolean().default(false),
  })
  .openapi("ProjectAccess");
export const TeamMember = z
  .object({
    id: Id,
    username: z.string(),
    displayName: z.string(),
    role: TenantRole,
    active: z.boolean(),
  })
  .openapi("TeamMember");
export const ProjectMember = TeamMember.extend({ projectRole: ProjectRole }).openapi(
  "ProjectMember",
);
export const MemberUpdate = z
  .object({
    role: z.enum(["admin", "member"]),
    active: z.boolean(),
  })
  .strict()
  .openapi("MemberUpdate");
export const InvitationInput = z
  .object({
    label: z.string().trim().min(1).max(80),
    projectId: Id.optional(),
    projectRole: ProjectRole.default("member"),
  })
  .strict()
  .openapi("InvitationInput");
export const Invitation = z
  .object({
    id: Id,
    label: z.string(),
    projectId: Id.nullable(),
    projectRole: ProjectRole,
    expiresAt: z.string(),
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
    createdAt: z.string(),
  })
  .openapi("Invitation");
export const InvitationCreated = z
  .object({ invitation: Invitation, token: z.string() })
  .openapi("InvitationCreated");
export const JoinInput = z
  .object({
    token: z.string().min(32).max(128),
    username: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{3,50}$/),
    displayName: z.string().trim().min(1).max(80),
    password: z.string().min(12).max(200),
  })
  .strict()
  .openapi("JoinInput");
export const AuditEntry = z
  .object({
    id: Id,
    actorName: z.string(),
    action: z.string(),
    targetId: z.string(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("AuditEntry");
