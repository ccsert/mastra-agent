import { randomUUID } from "node:crypto";
import {
  type Principal,
  ReleaseSnapshot,
  type SkillAccessRequest,
  type SkillBinding,
  SkillImportPreview,
  type SkillPreviewInput,
  SkillSnapshot,
  type SkillSource,
  type SkillSourceInput,
  SkillVersion,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { cursorPage, type PageInput } from "../../infrastructure/pagination.ts";
import { date } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";
import { importSkillArchive, sha256 } from "./archive.ts";
import { SkillSources } from "./sources.ts";

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
    source: row.source ?? null,
  });
export class Skills {
  constructor(
    private readonly db: Database,
    private readonly projects: Projects,
    private readonly runtimeId: string,
    private readonly sources = new SkillSources(),
  ) {}
  async availability(tx: Queryable, scope: { projectId: string; tenantId: string }, ids: string[]) {
    const rows = await tx.query(
      "SELECT id FROM skill_versions WHERE project_id=$1 AND tenant_id=$2 AND id=ANY($3::uuid[]) AND enabled=true",
      [scope.projectId, scope.tenantId, ids],
    );
    return new Set(rows.map((r) => String(r.id)));
  }
  async list(actor: Principal, projectId: string, input: PageInput = {}) {
    await this.projects.access.require(actor, projectId, "resource.read");
    requireUser(actor);
    const page = cursorPage([actor.tenantId, projectId, "skills"], input);
    const rows = await this.db.query(
      `SELECT s.id,s.project_id,s.version,s.digest,s.archive_hash,s.enabled,s.created_at,s.manifest,s.source,${page.select("s")} FROM skill_versions s WHERE s.project_id=$1 AND s.tenant_id=$2 AND ${page.where("s", 3)} ORDER BY s.created_at DESC,s.id DESC LIMIT $5`,
      [projectId, actor.tenantId, ...page.values],
    );
    return page.result(rows, dto);
  }
  async get(actor: Principal, projectId: string, id: string) {
    await this.projects.access.require(actor, projectId, "resource.read");
    requireUser(actor);
    return dto(await this.row(this.db, { projectId, tenantId: actor.tenantId }, id));
  }
  private async row(tx: Queryable, scope: { projectId: string; tenantId: string }, id: string) {
    const [row] = await tx.query(
      "SELECT id,project_id,version,digest,archive_hash,enabled,created_at,manifest,source FROM skill_versions WHERE id=$1 AND project_id=$2 AND tenant_id=$3",
      [id, scope.projectId, scope.tenantId],
    );
    if (!row) throw notFound();
    return row;
  }
  async upload(actor: Principal, projectId: string, base64: string) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    requireUser(actor);
    const pkg = await importSkillArchive(base64);
    return this.db.transaction(async (tx) => {
      return (await this.store(tx, actor, projectId, pkg, { kind: "zip", fileName: "skill.zip" }))
        .skill;
    });
  }
  private async store(
    tx: Queryable,
    actor: Principal,
    projectId: string,
    pkg: Awaited<ReturnType<typeof importSkillArchive>>,
    source: SkillSource,
    expectedBase?: string | null,
  ) {
    // Serialize versions within a project, including the first import of a new name.
    await tx.query("SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
      projectId,
      actor.tenantId,
    ]);
    await this.projects.access.require(actor, projectId, "resource.edit", tx);
    const [same] = await tx.query(
      "SELECT * FROM skill_versions WHERE project_id=$1 AND name=$2 AND digest=$3",
      [projectId, pkg.manifest.name, pkg.digest],
    );
    if (same) return { skill: dto(same), reused: true };
    const [last] = await tx.query(
      "SELECT id,version FROM skill_versions WHERE project_id=$1 AND name=$2 ORDER BY version DESC LIMIT 1",
      [projectId, pkg.manifest.name],
    );
    if (expectedBase !== undefined && (last?.id ?? null) !== expectedBase)
      throw new ApiError(
        409,
        "SKILL_IMPORT_STALE",
        "预览后已有其他人导入新版本，请重新预览并检查差异",
      );
    const id = randomUUID();
    const [row] = await tx.query(
      "INSERT INTO skill_versions(id,tenant_id,project_id,name,version,digest,archive_hash,archive,manifest,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [
        id,
        actor.tenantId,
        projectId,
        pkg.manifest.name,
        Number(last?.version ?? 0) + 1,
        pkg.digest,
        pkg.archiveHash,
        pkg.archive,
        pkg.manifest,
        source,
      ],
    );
    for (const [path, content] of pkg.files)
      await tx.query("INSERT INTO skill_files(version_id,path,content) VALUES($1,$2,$3)", [
        id,
        path,
        content,
      ]);
    return { skill: dto(row), reused: false };
  }
  async discover(actor: Principal, projectId: string, input: SkillSourceInput) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    requireUser(actor);
    return this.sources.discover(input);
  }
  async preview(actor: Principal, projectId: string, input: SkillPreviewInput) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    requireUser(actor);
    const { pkg, source } =
      input.kind === "zip"
        ? {
            pkg: await importSkillArchive(input.archiveBase64),
            source: { kind: "zip", fileName: input.fileName } as const,
          }
        : await this.sources.read(input.source, input.commit, input.path);
    return this.stage(actor, projectId, pkg, source);
  }
  async previewUpdate(actor: Principal, projectId: string, id: string) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    const current = await this.get(actor, projectId, id);
    if (!current.source || current.source.kind === "zip")
      throw new ApiError(
        400,
        "SKILL_SOURCE_MISSING",
        "此版本没有远端来源，请上传新版 ZIP 或粘贴来源链接",
      );
    const input = { url: current.source.url, ref: current.source.ref, path: current.source.path };
    const discovered = await this.sources.discover(input);
    const { pkg, source } = await this.sources.read(
      input,
      discovered.source.commit,
      current.source.path,
    );
    if (pkg.manifest.name !== current.name)
      throw new ApiError(
        409,
        "SKILL_NAME_CHANGED",
        "上游 Skill 名称已改变，请从导入入口将其作为新 Skill 检查",
      );
    return this.stage(actor, projectId, pkg, source);
  }
  private async stage(
    actor: Principal,
    projectId: string,
    pkg: Awaited<ReturnType<typeof importSkillArchive>>,
    source: SkillSource,
  ) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    const rows = await this.db.query(
      "SELECT id,project_id,version,digest,archive_hash,enabled,created_at,manifest,source FROM skill_versions WHERE project_id=$1 AND tenant_id=$2 AND name=$3 AND (digest=$4 OR version=(SELECT max(version) FROM skill_versions WHERE project_id=$1 AND name=$3)) ORDER BY version DESC",
      [projectId, actor.tenantId, pkg.manifest.name, pkg.digest],
    );
    const base = rows[0] ? dto(rows[0]) : null;
    const same = rows.find((row) => row.digest === pkg.digest);
    const oldFiles = new Map(base?.files.map((f) => [f.path, f.hash]));
    const files = new Map(pkg.manifest.files.map((f) => [f.path, f.hash]));
    const preview = SkillImportPreview.parse({
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      source,
      manifest: pkg.manifest,
      digest: pkg.digest,
      baseVersion: base,
      existingVersion: same ? dto(same) : null,
      changes: [...new Set([...files.keys(), ...oldFiles.keys()])].sort().flatMap((path) =>
        oldFiles.get(path) === files.get(path)
          ? []
          : [
              {
                path,
                kind: !oldFiles.has(path) ? "added" : !files.has(path) ? "removed" : "modified",
              },
            ],
      ),
    });
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
        projectId,
        actor.tenantId,
      ]);
      await this.projects.access.require(actor, projectId, "resource.edit", tx);
      await tx.query("DELETE FROM skill_import_previews WHERE project_id=$1 AND expires_at<now()", [
        projectId,
      ]);
      await tx.query(
        "DELETE FROM skill_import_previews WHERE id IN (SELECT id FROM skill_import_previews WHERE project_id=$1 AND actor_id=$2 ORDER BY created_at DESC OFFSET 9)",
        [projectId, actor.id],
      );
      await tx.query(
        "INSERT INTO skill_import_previews(id,tenant_id,project_id,actor_id,preview,archive,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [preview.id, actor.tenantId, projectId, actor.id, preview, pkg.archive, preview.expiresAt],
      );
    });
    return preview;
  }
  private async staged(tx: Queryable, actor: Principal, projectId: string, id: string) {
    const [row] = await tx.query(
      "SELECT * FROM skill_import_previews WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND expires_at>now() FOR UPDATE",
      [id, actor.tenantId, projectId, actor.id],
    );
    if (!row)
      throw new ApiError(
        404,
        "SKILL_PREVIEW_UNAVAILABLE",
        "预览不存在、已过期或不属于当前用户，请重新预览",
      );
    return row;
  }
  async previewFile(actor: Principal, projectId: string, id: string, path: string) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    requireUser(actor);
    const row = await this.staged(this.db, actor, projectId, id);
    if (row.result_version_id)
      return this.file(actor, projectId, String(row.result_version_id), path);
    const pkg = await importSkillArchive((row.archive as Buffer).toString("base64"));
    const bytes = pkg.files.get(path);
    if (!bytes) throw notFound();
    return { path, contentBase64: bytes.toString("base64"), hash: sha256(bytes) };
  }
  async confirmImport(actor: Principal, projectId: string, id: string) {
    await this.projects.access.require(actor, projectId, "resource.edit");
    requireUser(actor);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [
        projectId,
        actor.tenantId,
      ]);
      await this.projects.access.require(actor, projectId, "resource.edit", tx);
      const row = await this.staged(tx, actor, projectId, id);
      if (row.result_version_id)
        return {
          skill: dto(
            await this.row(
              tx,
              { projectId, tenantId: actor.tenantId },
              String(row.result_version_id),
            ),
          ),
          reused: true,
        };
      const preview = SkillImportPreview.parse(row.preview);
      const pkg = await importSkillArchive((row.archive as Buffer).toString("base64"));
      if (pkg.digest !== preview.digest)
        throw new ApiError(409, "SKILL_CONTENT_INVALID", "预览内容完整性校验失败，请重新预览");
      const result = await this.store(
        tx,
        actor,
        projectId,
        pkg,
        preview.source,
        preview.baseVersion?.id ?? null,
      );
      await tx.query(
        "UPDATE skill_import_previews SET result_version_id=$1,archive=NULL WHERE id=$2",
        [result.skill.id, id],
      );
      await this.projects.access.record(
        tx,
        actor,
        "skill.import",
        result.skill.id,
        {
          name: result.skill.name,
          version: result.skill.version,
          source: preview.source,
          digest: result.skill.digest,
          reused: result.reused,
        },
        projectId,
      );
      return result;
    });
  }
  async setEnabled(actor: Principal, projectId: string, id: string, enabled: boolean) {
    await this.projects.access.require(actor, projectId, "resource.manage");
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
