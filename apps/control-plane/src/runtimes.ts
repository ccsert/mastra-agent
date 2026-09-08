import type { Principal } from "@platform/contracts";
import type { Database } from "@platform/database";
import { requireUser } from "./projects.ts";
import { date, text } from "./records.ts";
export class Runtimes {
  constructor(
    private readonly db: Database,
    private readonly runtimeId: string,
  ) {}
  async list(actor: Principal) {
    requireUser(actor);
    return (await this.db.query("SELECT * FROM runtimes WHERE id=$1", [this.runtimeId])).map(
      (r) => ({
        id: text(r, "id"),
        name: text(r, "name"),
        lastSeenAt: r.last_seen_at ? date(r.last_seen_at) : null,
        online: !!r.last_seen_at && Date.now() - new Date(date(r.last_seen_at)).valueOf() < 15000,
      }),
    );
  }
}
