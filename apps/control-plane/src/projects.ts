import { randomUUID } from "node:crypto";
import { type Principal, Project } from "@platform/contracts";
import type { Database, Queryable } from "@platform/database";
import { ApiError, notFound } from "./errors.ts";

import { date } from "./records.ts";
export function requireUser(actor: Principal) {
  if (actor.kind !== "user")
    throw new ApiError(403, "MANAGEMENT_NOT_ALLOWED", "应用凭据仅用于调用已发布 Agent");
}
export class Projects {
  constructor(private readonly db: Database) {}
  async get(actor: Principal, id: string, tx: Queryable = this.db) {
    if (actor.kind === "application" && actor.projectId !== id) throw notFound();
    const [r] = await tx.query("SELECT * FROM projects WHERE id=$1 AND tenant_id=$2", [
      id,
      actor.tenantId,
    ]);
    if (!r) throw notFound();
    return Project.parse({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      description: r.description,
      createdAt: date(r.created_at),
    });
  }
  async list(actor: Principal) {
    const rows = await this.db.query(
      "SELECT * FROM projects WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at",
      [actor.tenantId, actor.projectId ?? null],
    );
    return rows.map((r) =>
      Project.parse({
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        description: r.description,
        createdAt: date(r.created_at),
      }),
    );
  }
  async create(actor: Principal, input: { name: string; description: string }) {
    requireUser(actor);
    const id = randomUUID();
    await this.db.query("INSERT INTO projects(id,tenant_id,name,description) VALUES($1,$2,$3,$4)", [
      id,
      actor.tenantId,
      input.name,
      input.description,
    ]);
    return this.get(actor, id);
  }
}
