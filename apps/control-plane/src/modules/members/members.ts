import { randomBytes, randomUUID } from "node:crypto";
import {
  AuditEntry,
  Invitation,
  type InvitationInput,
  type JoinInput,
  type MemberUpdate,
  type Principal,
  ProjectMember,
  type ProjectRole,
  TeamMember,
  type z,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { hashPassword, sha256 } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { date } from "../../infrastructure/records.ts";
import type { Access } from "../access/index.ts";

const member = (r: Row) =>
  TeamMember.parse({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    active: r.active,
  });
const invitation = (r: Row) =>
  Invitation.parse({
    id: r.id,
    label: r.label,
    projectId: r.project_id,
    projectRole: r.project_role,
    createdAt: date(r.created_at),
    expiresAt: date(r.expires_at),
    status: r.accepted_at
      ? "accepted"
      : r.revoked_at
        ? "revoked"
        : new Date(String(r.expires_at)).getTime() <= Date.now()
          ? "expired"
          : "pending",
  });

/** Membership changes and invitation consumption serialize within their tenant. */
export class Members {
  constructor(
    private readonly db: Database,
    private readonly access: Access,
  ) {}
  private async lock(tx: Queryable, tenantId: string) {
    await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
  }
  async list(actor: Principal) {
    await this.access.manageTenant(actor);
    return (
      await this.db.query("SELECT * FROM users WHERE tenant_id=$1 ORDER BY username", [
        actor.tenantId,
      ])
    ).map(member);
  }
  async update(actor: Principal, id: string, input: z.infer<typeof MemberUpdate>) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      const role = await this.access.manageTenant(actor, tx);
      const [target] = await tx.query(
        "SELECT * FROM users WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [id, actor.tenantId],
      );
      if (!target) throw notFound();
      if (target.role === "owner") throw new ApiError(409, "OWNER_PROTECTED", "请先移交团队所有权");
      if (actor.id === id)
        throw new ApiError(409, "SELF_CHANGE", "不能在成员管理中修改自己的角色或状态");
      if (role !== "owner" && (target.role === "admin" || input.role === "admin"))
        throw new ApiError(403, "OWNER_REQUIRED", "只有团队所有者可以管理管理员");
      const [updated] = await tx.query(
        "UPDATE users SET role=$1,active=$2 WHERE id=$3 RETURNING *",
        [input.role, input.active, id],
      );
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await tx.query(
        "UPDATE member_invitations SET revoked_at=now() WHERE created_by=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
        [id],
      );
      await this.access.record(tx, actor, "member.updated", id, {
        before: { role: target.role, active: target.active },
        after: input,
      });
      return member(updated);
    });
  }
  async revokeSessions(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      const role = await this.access.manageTenant(actor, tx);
      const [target] = await tx.query("SELECT role FROM users WHERE id=$1 AND tenant_id=$2", [
        id,
        actor.tenantId,
      ]);
      if (!target) throw notFound();
      if (role !== "owner" && target.role !== "member" && id !== actor.id)
        throw new ApiError(403, "OWNER_REQUIRED", "只有团队所有者可以管理管理员的会话");
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await this.access.record(tx, actor, "member.sessions_revoked", id);
    });
  }
  async transfer(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      if ((await this.access.tenant(actor, tx)) !== "owner")
        throw new ApiError(403, "OWNER_REQUIRED", "只有团队所有者可以移交所有权");
      const [target] = await tx.query(
        "SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND active AND id<>$3",
        [id, actor.tenantId, actor.id],
      );
      if (!target) throw notFound();
      await tx.query("UPDATE users SET role='admin' WHERE id=$1", [actor.id]);
      await tx.query("UPDATE users SET role='owner' WHERE id=$1", [id]);
      await this.access.record(tx, actor, "team.owner_transferred", id);
    });
  }
  async candidates(actor: Principal, projectId: string, query: string) {
    await this.access.require(actor, projectId, "project.manage");
    return (
      await this.db.query(
        "SELECT * FROM users WHERE tenant_id=$1 AND active AND (strpos(lower(username),lower($2))>0 OR strpos(lower(display_name),lower($2))>0) ORDER BY username LIMIT 100",
        [actor.tenantId, query],
      )
    ).map(member);
  }
  async projectMembers(actor: Principal, projectId: string) {
    await this.access.require(actor, projectId, "project.manage");
    return (
      await this.db.query(
        `SELECT u.*,CASE WHEN u.role IN ('owner','admin') THEN 'admin' ELSE m.role END AS project_role
       FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=$1
       WHERE u.tenant_id=$2 AND (m.user_id IS NOT NULL OR u.role IN ('owner','admin')) ORDER BY u.username`,
        [projectId, actor.tenantId],
      )
    ).map((r) => ProjectMember.parse({ ...member(r), projectRole: r.project_role }));
  }
  async setProjectMember(
    actor: Principal,
    projectId: string,
    id: string,
    role: z.infer<typeof ProjectRole> | null,
  ) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      await this.access.require(actor, projectId, "project.manage", tx);
      const [target] = await tx.query("SELECT * FROM users WHERE id=$1 AND tenant_id=$2", [
        id,
        actor.tenantId,
      ]);
      if (!target) throw notFound();
      if (target.role !== "member")
        throw new ApiError(409, "INHERITED_ACCESS", "团队管理员的访问权由团队角色继承");
      if (id === actor.id) throw new ApiError(409, "SELF_CHANGE", "请由其他管理员调整你的项目角色");
      if (role && !target.active) throw new ApiError(409, "MEMBER_DISABLED", "请先启用该账号");
      if (role)
        await tx.query(
          "INSERT INTO project_members(tenant_id,project_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role",
          [actor.tenantId, projectId, id, role],
        );
      else
        await tx.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [
          projectId,
          id,
        ]);
      await tx.query(
        "UPDATE member_invitations SET revoked_at=now() WHERE created_by=$1 AND project_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
        [id, projectId],
      );
      await this.access.record(
        tx,
        actor,
        role ? "project.member_updated" : "project.member_removed",
        id,
        { role },
        projectId,
      );
    });
  }
  async invite(actor: Principal, input: z.infer<typeof InvitationInput>) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      if (input.projectId) await this.access.require(actor, input.projectId, "project.manage", tx);
      else await this.access.manageTenant(actor, tx);
      const token = randomBytes(32).toString("base64url");
      const [row] = await tx.query(
        "INSERT INTO member_invitations(id,tenant_id,token_hash,label,project_id,project_role,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '3 days') RETURNING *",
        [
          randomUUID(),
          actor.tenantId,
          sha256(token),
          input.label,
          input.projectId ?? null,
          input.projectRole,
          actor.id,
        ],
      );
      await this.access.record(
        tx,
        actor,
        "invitation.created",
        String(row.id),
        { label: input.label, projectRole: input.projectRole },
        input.projectId,
      );
      return { invitation: invitation(row), token };
    });
  }
  async invitations(actor: Principal, projectId?: string) {
    if (projectId) await this.access.require(actor, projectId, "project.manage");
    else await this.access.manageTenant(actor);
    return (
      await this.db.query(
        "SELECT * FROM member_invitations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 100",
        [actor.tenantId, projectId ?? null],
      )
    ).map(invitation);
  }
  async revokeInvitation(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, actor.tenantId);
      const [r] = await tx.query("SELECT * FROM member_invitations WHERE id=$1 AND tenant_id=$2", [
        id,
        actor.tenantId,
      ]);
      if (!r) throw notFound();
      if (r.project_id)
        await this.access.require(actor, String(r.project_id), "project.manage", tx);
      else await this.access.manageTenant(actor, tx);
      await tx.query(
        "UPDATE member_invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL",
        [id],
      );
      await this.access.record(
        tx,
        actor,
        "invitation.revoked",
        id,
        {},
        r.project_id ? String(r.project_id) : undefined,
      );
    });
  }
  async join(input: z.infer<typeof JoinInput>) {
    const password = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx.query(
        "SELECT tenant_id FROM member_invitations WHERE token_hash=$1",
        [sha256(input.token)],
      );
      if (!candidate)
        throw new ApiError(400, "INVITATION_INVALID", "邀请已失效，请联系管理员重新邀请");
      await this.lock(tx, String(candidate.tenant_id));
      const [r] = await tx.query(
        "SELECT * FROM member_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        [sha256(input.token)],
      );
      if (!r) throw new ApiError(400, "INVITATION_INVALID", "邀请已失效，请联系管理员重新邀请");
      const id = randomUUID();
      const [user] = await tx.query(
        "INSERT INTO users(id,tenant_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,'member') ON CONFLICT(username) DO NOTHING RETURNING *",
        [id, r.tenant_id, input.username, input.displayName, password],
      );
      if (!user) throw new ApiError(409, "USERNAME_TAKEN", "该账号已被使用，请选择其他账号");
      if (r.project_id)
        await tx.query(
          "INSERT INTO project_members(tenant_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",
          [r.tenant_id, r.project_id, id, r.project_role],
        );
      await tx.query("UPDATE member_invitations SET accepted_at=now() WHERE id=$1", [r.id]);
      await this.access.record(
        tx,
        {
          id,
          tenantId: String(r.tenant_id),
          displayName: input.displayName,
          kind: "user",
          entry: "console",
        },
        "invitation.accepted",
        String(r.id),
        {},
        r.project_id ? String(r.project_id) : undefined,
      );
      return member(user);
    });
  }
  async audit(actor: Principal, projectId?: string) {
    if (projectId) await this.access.require(actor, projectId, "project.manage");
    else await this.access.manageTenant(actor);
    return (
      await this.db.query(
        "SELECT * FROM access_audit WHERE tenant_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100",
        [actor.tenantId, projectId ?? null],
      )
    ).map((r) =>
      AuditEntry.parse({
        id: r.id,
        actorName: r.actor_name,
        action: r.action,
        targetId: r.target_id,
        details: r.details,
        createdAt: date(r.created_at),
      }),
    );
  }
}
