import { randomUUID } from "node:crypto";
import { type Principal, Project } from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { date } from "../../infrastructure/records.ts";
import { Access } from "../access/index.ts";
export function requireUser(actor: Principal) {
  if (actor.kind !== "user")
    throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用凭据仅用于调用已发布 Agent");
}
const project = (r: Row) =>
  Project.parse({
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description,
    createdAt: date(r.created_at),
    archivedAt: r.archived_at ? date(r.archived_at) : null,
  });
export class Projects {
  readonly access: Access;
  constructor(private readonly db: Database) {
    this.access = new Access(db);
  }
  async get(actor: Principal, id: string, tx: Queryable = this.db) {
    const { project: r } = await this.access.scope(actor, id, tx);
    return project(r);
  }
  async list(actor: Principal) {
    if (actor.kind === "user") await this.access.tenant(actor);
    const rows = await this.db.query(
      `SELECT p.* FROM projects p WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.id=$2)
       AND ($4::boolean OR EXISTS (SELECT 1 FROM users u WHERE u.id=$3 AND u.tenant_id=p.tenant_id AND u.active
         AND (u.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=u.id))))
       ORDER BY p.created_at`,
      [actor.tenantId, actor.projectId ?? null, actor.id, actor.kind === "application"],
    );
    return rows.map(project);
  }
  async create(actor: Principal, input: { name: string; description: string }) {
    await this.access.manageTenant(actor);
    const id = randomUUID();
    await this.db.query("INSERT INTO projects(id,tenant_id,name,description) VALUES($1,$2,$3,$4)", [
      id,
      actor.tenantId,
      input.name,
      input.description,
    ]);
    return this.get(actor, id);
  }
  async update(actor: Principal, id: string, input: { name?: string; description?: string }) {
    return this.db.transaction(async (tx) => {
      await this.access.require(actor, id, "project.manage", tx);
      const [row] = await tx.query(
        "UPDATE projects SET name=COALESCE($1,name),description=COALESCE($2,description) WHERE id=$3 RETURNING *",
        [input.name ?? null, input.description ?? null, id],
      );
      if (!row) throw notFound();
      await this.access.record(tx, actor, "project.updated", id, { after: input }, id);
      return project(row);
    });
  }
  async setArchived(actor: Principal, id: string, archived: boolean) {
    return this.db.transaction(async (tx) => {
      const { project: current } = await this.access.scope(actor, id, tx);
      await this.access.require(actor, id, "project.manage", tx);
      if (!!current.archived_at === archived) return project(current);
      const [row] = await tx.query("UPDATE projects SET archived_at=$1 WHERE id=$2 RETURNING *", [
        archived ? new Date() : null,
        id,
      ]);
      await this.access.record(
        tx,
        actor,
        archived ? "project.archived" : "project.restored",
        id,
        {},
        id,
      );
      return project(row);
    });
  }
}
