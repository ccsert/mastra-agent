import { randomUUID } from "node:crypto";
import {
  type Principal,
  ReleaseSnapshot,
  type SkillAccessRequest,
  type SkillBinding,
  SkillSnapshot,
  SkillVersion,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { date } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";
import { importSkillArchive, sha256 } from "./archive.ts";

const denied = () =>
  new ApiError(403, "SKILL_ACCESS_DENIED", "Skill 版本已停用、未授权或运行访问已失效");
const dto = (row: Row) =>
  SkillVersion.parse({
    ...(row.manifest as object),
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    digest: row.digest,
    archiveHash: row.archive_hash,
    enabled: row.enabled,
    createdAt: date(row.created_at),
  });
export class Skills {
  constructor(
    private readonly db: Database,
    private readonly projects: Projects,
    private readonly runtimeId: string,
  ) {}
  async list(actor: Principal, projectId: string, input: PageInput = {}) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    const page = cursorPage([actor.tenantId, projectId, "skills"], input);
    const rows = await this.db.query(
      `SELECT s.id,s.project_id,s.version,s.digest,s.archive_hash,s.enabled,s.created_at,s.manifest,${page.select("s")} FROM skill_versions s WHERE s.project_id=$1 AND s.tenant_id=$2 AND ${page.where("s", 3)} ORDER BY s.created_at DESC,s.id DESC LIMIT $5`,
      [projectId, actor.tenantId, ...page.values],
    );
    return page.result(rows, dto);
  }
  async get(actor: Principal, projectId: string, id: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    return dto(await this.row(this.db, { projectId, tenantId: actor.tenantId }, id));
  }
  private async row(tx: Queryable, scope: { projectId: string; tenantId: string }, id: string) {
    const [row] = await tx.query(
      "SELECT id,project_id,version,digest,archive_hash,enabled,created_at,manifest FROM skill_versions WHERE id=$1 AND project_id=$2 AND tenant_id=$3",
      [id, scope.projectId, scope.tenantId],
    );
    if (!row) throw notFound();
    return row;
  }
  async upload(actor: Principal, projectId: string, base64: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    const pkg = await importSkillArchive(base64);
    return this.db.transaction(async (tx) => {
      // Serialize versions within a project, including the first import of a new name.
      await tx.query("SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
        projectId,
        actor.tenantId,
      ]);
      const [same] = await tx.query(
        "SELECT * FROM skill_versions WHERE project_id=$1 AND name=$2 AND digest=$3",
        [projectId, pkg.manifest.name, pkg.digest],
      );
      if (same) return dto(same);
      const [last] = await tx.query(
        "SELECT coalesce(max(version),0) AS version FROM skill_versions WHERE project_id=$1 AND name=$2",
        [projectId, pkg.manifest.name],
      );
      const id = randomUUID();
      const [row] = await tx.query(
        "INSERT INTO skill_versions(id,tenant_id,project_id,name,version,digest,archive_hash,archive,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          id,
          actor.tenantId,
          projectId,
          pkg.manifest.name,
          Number(last.version) + 1,
          pkg.digest,
          pkg.archiveHash,
          pkg.archive,
          pkg.manifest,
        ],
      );
      for (const [path, content] of pkg.files)
        await tx.query("INSERT INTO skill_files(version_id,path,content) VALUES($1,$2,$3)", [
          id,
          path,
          content,
        ]);
      return dto(row);
    });
  }
  async setEnabled(actor: Principal, projectId: string, id: string, enabled: boolean) {
    await this.get(actor, projectId, id);
    await this.db.query(
      "UPDATE skill_versions SET enabled=$1 WHERE id=$2 AND project_id=$3 AND tenant_id=$4",
      [enabled, id, projectId, actor.tenantId],
    );
    return this.get(actor, projectId, id);
  }
  async file(actor: Principal, projectId: string, id: string, path: string) {
    const version = await this.get(actor, projectId, id);
    return this.read(this.db, version, path);
  }
  private async read(tx: Queryable, version: SkillVersion | SkillSnapshot, path: string) {
    const file = version.files.find((f) => f.path === path);
    if (!file) throw notFound();
    const [row] = await tx.query(
      "SELECT content FROM skill_files WHERE version_id=$1 AND path=$2",
      [version.id, path],
    );
    if (
      !row ||
      !Buffer.isBuffer(row.content) ||
      row.content.length !== file.size ||
      sha256(row.content) !== file.hash
    )
      throw new ApiError(409, "SKILL_CONTENT_INVALID", "Skill 内容完整性校验失败");
    return { path, contentBase64: row.content.toString("base64"), hash: file.hash };
  }
  async snapshots(
    tx: Queryable,
    scope: { projectId: string; tenantId: string },
    bindings: SkillBinding[],
  ) {
    const snapshots: SkillSnapshot[] = [],
      names = new Set<string>();
    for (const binding of bindings) {
      const version = dto(await this.row(tx, scope, binding.versionId));
      if (
        !version.enabled ||
        names.has(version.name) ||
        new Set(binding.entrypoints).size !== binding.entrypoints.length ||
        binding.entrypoints.some((p) => !version.entrypoints.includes(p))
      )
        throw denied();
      names.add(version.name);
      snapshots.push(
        SkillSnapshot.parse({ ...version, authorizedEntrypoints: binding.entrypoints }),
      );
    }
    return snapshots;
  }
  async access(
    tx: Queryable,
    scope: { projectId: string; tenantId: string },
    snapshot: ReleaseSnapshot,
    input: SkillAccessRequest,
  ) {
    const pinned = snapshot.skills.find((s) => s.id === input.versionId);
    if (!pinned) throw denied();
    const current = dto(await this.row(tx, scope, input.versionId));
    if (
      !current.enabled ||
      current.digest !== pinned.digest ||
      sha256(JSON.stringify(current.files)) !== pinned.digest
    )
      throw denied();
    if (
      input.operation === "execute" &&
      (!input.path || !pinned.authorizedEntrypoints.includes(input.path))
    )
      throw denied();
    if (input.operation === "read") {
      if (!input.path) throw denied();
      return this.read(tx, pinned, input.path);
    }
    return { ok: true };
  }
  async runAccess(id: string, input: SkillAccessRequest) {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query(
        "SELECT r.*, rel.snapshot FROM runs r JOIN releases rel ON rel.id=r.release_id AND rel.project_id=r.project_id WHERE r.id=$1 AND r.runtime_id=$2 AND r.status='running' AND r.lease_token=$3 AND r.lease_until>clock_timestamp() AND r.deadline>clock_timestamp() AND NOT r.cancel_requested FOR SHARE OF r",
        [id, this.runtimeId, input.leaseToken],
      );
      if (!run) throw denied();
      if (String(run.entry).startsWith("app:")) {
        const [app] = await tx.query(
          "SELECT active FROM applications WHERE id=$1 AND project_id=$2 AND tenant_id=$3",
          [run.actor_id, run.project_id, run.tenant_id],
        );
        if (!app?.active) throw denied();
      }
      return this.access(
        tx,
        { tenantId: String(run.tenant_id), projectId: String(run.project_id) },
        ReleaseSnapshot.parse(run.snapshot),
        input,
      );
    });
  }
}
