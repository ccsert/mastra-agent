import { randomUUID } from "node:crypto";
import { type Permission, type Principal, ProjectAccess } from "@platform/contracts";
import type { Database, Queryable } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";

const grants: Record<string, Permission[]> = {
  admin: [
    "project.read",
    "project.manage",
    "agent.edit",
    "agent.publish",
    "agent.run",
    "resource.read",
    "resource.edit",
    "resource.manage",
  ],
  editor: ["project.read", "agent.edit", "agent.run", "resource.read", "resource.edit"],
  member: ["project.read", "agent.run"],
  viewer: ["project.read", "resource.read"],
};

/** Reads current membership for every request. Session claims never cache authorization. */
export class Access {
  constructor(private readonly db: Database) {}
  async tenant(actor: Principal, tx: Queryable = this.db) {
    if (actor.kind !== "user")
      throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用身份不能管理团队");
    const [user] = await tx.query(
      "SELECT role FROM users WHERE id=$1 AND tenant_id=$2 AND active",
      [actor.id, actor.tenantId],
    );
    if (!user) throw notFound();
    return String(user.role);
  }
  async manageTenant(actor: Principal, tx: Queryable = this.db) {
    const role = await this.tenant(actor, tx);
    if (role !== "owner" && role !== "admin")
      throw new ApiError(403, "FORBIDDEN", "需要团队管理员权限");
    return role;
  }
  async scope(actor: Principal, projectId: string, tx: Queryable = this.db) {
    if (actor.kind === "application") {
      if (actor.projectId !== projectId) throw notFound();
      const [project] = await tx.query("SELECT * FROM projects WHERE id=$1 AND tenant_id=$2", [
        projectId,
        actor.tenantId,
      ]);
      if (!project) throw notFound();
      return {
        project,
        access: ProjectAccess.parse({
          projectId,
          role: null,
          tenantRole: null,
          permissions: ["project.read", "agent.run"],
        }),
      };
    }
    const [r] = await tx.query(
      `SELECT p.*,u.role AS tenant_role,m.role AS member_role FROM projects p
       JOIN users u ON u.tenant_id=p.tenant_id AND u.id=$1 AND u.active
       LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id
       WHERE p.id=$2 AND p.tenant_id=$3`,
      [actor.id, projectId, actor.tenantId],
    );
    if (!r) throw notFound();
    const role =
      r.tenant_role === "owner" || r.tenant_role === "admin"
        ? "admin"
        : String(r.member_role ?? "");
    if (!grants[role]) throw notFound();
    return {
      project: r,
      access: ProjectAccess.parse({
        projectId,
        role,
        tenantRole: r.tenant_role,
        permissions: grants[role],
      }),
    };
  }
  async project(actor: Principal, projectId: string, tx: Queryable = this.db) {
    return (await this.scope(actor, projectId, tx)).access;
  }
  async require(
    actor: Principal,
    projectId: string,
    permission: Permission,
    tx: Queryable = this.db,
  ) {
    const access = await this.project(actor, projectId, tx);
    if (!access.permissions.includes(permission))
      throw new ApiError(403, "FORBIDDEN", "当前项目角色没有此操作权限");
    return access;
  }
  async record(
    tx: Queryable,
    actor: Principal,
    action: string,
    targetId: string,
    details: Record<string, unknown> = {},
    projectId?: string,
  ) {
    await tx.query(
      "INSERT INTO access_audit(id,tenant_id,project_id,actor_id,actor_name,action,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        actor.tenantId,
        projectId ?? null,
        actor.id,
        actor.displayName,
        action,
        targetId,
        details,
      ],
    );
  }
}
