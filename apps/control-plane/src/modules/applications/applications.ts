import { randomBytes, randomUUID } from "node:crypto";
import { Application, type Principal } from "@platform/contracts";
import type { Database, Row } from "@platform/database";
import { secureEqual, signRequest, type Vault } from "../../infrastructure/crypto.ts";
import { ApiError } from "../../infrastructure/errors.ts";
import { date, text } from "../../infrastructure/records.ts";
import { type Projects, requireUser } from "../projects/index.ts";

const appDto = (r: Row) =>
  Application.parse({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    accessKey: r.access_key,
    active: r.active,
    createdAt: date(r.created_at),
  });
export class Applications {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
    private readonly projects: Projects,
  ) {}
  async authenticate(request: Request): Promise<Principal> {
    const auth = request.headers.get("authorization") ?? "",
      timestamp = request.headers.get("x-platform-date") ?? "",
      nonce = request.headers.get("x-platform-nonce") ?? "";
    const match = /^Platform-HMAC ([a-f0-9-]+):([a-f0-9]+):([a-f0-9]{64})$/.exec(auth);
    if (
      !match ||
      !Number.isFinite(Date.parse(timestamp)) ||
      Math.abs(Date.now() - Date.parse(timestamp)) > 300000 ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(nonce)
    )
      throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const [, id, accessKey, signature] = match;
    const [app] = await this.db.query(
      "SELECT * FROM applications WHERE id=$1 AND access_key=$2 AND active=true",
      [id, accessKey],
    );
    if (!app) throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const url = new URL(request.url),
      body = await request.clone().text();
    const expected = signRequest(
      request.method,
      url.pathname + url.search,
      timestamp,
      nonce,
      body,
      this.vault.decrypt(text(app, "secret_enc")),
    );
    if (!secureEqual(signature, expected))
      throw new ApiError(401, "INVALID_SIGNATURE", "应用签名无效或已过期");
    const inserted = await this.db.query(
      "INSERT INTO auth_nonces(application_id,nonce,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING nonce",
      [id, nonce],
    );
    if (!inserted.length) throw new ApiError(401, "REPLAY_DETECTED", "请求签名已使用");
    return {
      id,
      tenantId: text(app, "tenant_id"),
      projectId: text(app, "project_id"),
      displayName: text(app, "name"),
      kind: "application",
      entry: `app:${id}`,
    };
  }
  async list(actor: Principal, projectId: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    return (
      await this.db.query(
        "SELECT * FROM applications WHERE project_id=$1 ORDER BY created_at DESC",
        [projectId],
      )
    ).map(appDto);
  }
  async create(actor: Principal, projectId: string, name: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    const secretKey = randomBytes(32).toString("hex");
    const [r] = await this.db.query(
      "INSERT INTO applications(id,tenant_id,project_id,name,access_key,secret_enc) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        randomUUID(),
        actor.tenantId,
        projectId,
        name,
        randomBytes(16).toString("hex"),
        this.vault.encrypt(secretKey),
      ],
    );
    return { ...appDto(r), secretKey };
  }
  async revoke(actor: Principal, projectId: string, id: string) {
    requireUser(actor);
    await this.projects.get(actor, projectId);
    await this.db.query("UPDATE applications SET active=false WHERE id=$1 AND project_id=$2", [
      id,
      projectId,
    ]);
  }
}
