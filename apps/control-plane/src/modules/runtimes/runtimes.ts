import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Principal, RuntimeRegistered } from "@platform/contracts";
import type { Database } from "@platform/database";
import { secureEqual } from "../../infrastructure/crypto.ts";
import { ApiError } from "../../infrastructure/errors.ts";
import { date, text } from "../../infrastructure/records.ts";
import type { Access } from "../access/index.ts";
import { requireUser } from "../projects/index.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Runtimes {
  constructor(
    private readonly db: Database,
    private readonly runtimeId: string,
    private readonly access: Access,
  ) {}
  async list(actor: Principal) {
    requireUser(actor);
    const rows = await this.db.query(
      "SELECT id,name,last_seen_at,enabled FROM runtimes ORDER BY (id=$1) DESC, id",
      [this.runtimeId],
    );
    return rows.map((r) => ({
      id: text(r, "id"),
      name: text(r, "name"),
      lastSeenAt: r.last_seen_at ? date(r.last_seen_at) : null,
      online: !!r.last_seen_at && Date.now() - new Date(date(r.last_seen_at)).valueOf() < 15000,
      enabled: !!r.enabled,
      builtIn: r.id === this.runtimeId,
    }));
  }
  /** Registry authentication for runtimes connecting with issued credentials.
   * The seeded built-in row stores no hash: the deployment's own token is
   * checked by the middleware before this is consulted. */
  async authenticate(id: string | undefined, token: string) {
    if (!id || !token) return false;
    const [row] = await this.db.query("SELECT enabled,token_hash FROM runtimes WHERE id=$1", [id]);
    if (!row?.enabled || !row.token_hash) return false;
    return secureEqual(String(row.token_hash), hash(token));
  }
  async hostedEnabled() {
    const [row] = await this.db.query("SELECT enabled FROM runtimes WHERE id=$1", [this.runtimeId]);
    return !row || !!row.enabled;
  }
  async register(actor: Principal, input: { name: string }): Promise<RuntimeRegistered> {
    await this.access.manageTenant(actor);
    const id = `rt-${randomUUID()}`,
      token = randomBytes(32).toString("hex");
    await this.db.query("INSERT INTO runtimes(id,name,enabled,token_hash) VALUES($1,$2,true,$3)", [
      id,
      input.name,
      hash(token),
    ]);
    await this.access.record(this.db, actor, "runtime.registered", id, { name: input.name });
    return { id, name: input.name, token };
  }
  async update(actor: Principal, id: string, input: { name?: string; enabled?: boolean }) {
    await this.access.manageTenant(actor);
    if (id === this.runtimeId && input.enabled === false)
      throw new ApiError(409, "RUNTIME_BUILT_IN", "托管 Runtime 不能停用，请先迁移项目");
    const [row] = await this.db.query("SELECT name FROM runtimes WHERE id=$1", [id]);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Runtime 不存在");
    const sets: string[] = [],
      values: unknown[] = [id];
    if (input.name !== undefined) {
      values.push(input.name);
      sets.push(`name=$${values.length}`);
    }
    if (input.enabled !== undefined) {
      values.push(input.enabled);
      sets.push(`enabled=$${values.length}`);
    }
    await this.db.query(`UPDATE runtimes SET ${sets.join(",")} WHERE id=$1`, values);
    await this.access.record(this.db, actor, "runtime.updated", id, { ...input });
    return this.describe(id);
  }
  async delete(actor: Principal, id: string) {
    await this.access.manageTenant(actor);
    if (id === this.runtimeId) throw new ApiError(409, "RUNTIME_BUILT_IN", "托管 Runtime 不能删除");
    const [busy] = await this.db.query(
      "SELECT count(*)::int AS n FROM runs WHERE runtime_id=$1 AND status IN ('queued','running')",
      [id],
    );
    if (Number(busy?.n ?? 0) > 0)
      throw new ApiError(409, "RUNTIME_BUSY", "仍有排队或运行中的任务，请先处理后再删除");
    const [row] = await this.db.query("SELECT name FROM runtimes WHERE id=$1", [id]);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Runtime 不存在");
    await this.db.query("DELETE FROM runtimes WHERE id=$1", [id]);
    await this.access.record(this.db, actor, "runtime.deleted", id, { name: text(row, "name") });
  }
  private async describe(id: string) {
    const [row] = await this.db.query(
      "SELECT id,name,last_seen_at,enabled FROM runtimes WHERE id=$1",
      [id],
    );
    return {
      id: text(row, "id"),
      name: text(row, "name"),
      lastSeenAt: row.last_seen_at ? date(row.last_seen_at) : null,
      online: !!row.last_seen_at && Date.now() - new Date(date(row.last_seen_at)).valueOf() < 15000,
      enabled: !!row.enabled,
      builtIn: row.id === this.runtimeId,
    };
  }
}
