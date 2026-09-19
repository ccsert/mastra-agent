import { randomBytes, randomUUID } from "node:crypto";
import type { Principal } from "@platform/contracts";
import type { Database } from "@platform/database";
import { hashPassword, sha256, verifyPassword } from "../../infrastructure/crypto.ts";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { text } from "../../infrastructure/records.ts";
import type { Access } from "../access/index.ts";
export class Identity {
  constructor(
    private readonly db: Database,
    private readonly access?: Access,
  ) {}
  async isSetup() {
    return (await this.db.query("SELECT id FROM users LIMIT 1")).length > 0;
  }
  async setup(username: string, password: string, workspaceName: string) {
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(2947302)");
      if ((await tx.query("SELECT id FROM users LIMIT 1")).length)
        throw new ApiError(409, "ALREADY_INITIALIZED", "平台已初始化，请登录");
      const tenantId = randomUUID(),
        userId = randomUUID();
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [tenantId, workspaceName]);
      await tx.query(
        "INSERT INTO users(id,tenant_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,$5,'owner')",
        [userId, tenantId, username, username, passwordHash],
      );
      return { tenantId, userId };
    });
  }
  async login(username: string, password: string) {
    const [user] = await this.db.query("SELECT * FROM users WHERE username=$1 AND active", [
      username,
    ]);
    if (!user) {
      await hashPassword(password);
      throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    }
    if (!(await verifyPassword(password, text(user, "password_hash"))))
      throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    const token = randomBytes(32).toString("hex");
    await this.db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
      [sha256(token), user.id],
    );
    return token;
  }
  async logout(token: string) {
    await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
  }
  async session(token: string): Promise<Principal> {
    const [r] = await this.db.query(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active",
      [sha256(token)],
    );
    if (!r) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
    return {
      id: text(r, "id"),
      tenantId: text(r, "tenant_id"),
      displayName: text(r, "display_name"),
      kind: "user",
      entry: "console",
      tenantRole: r.role as Principal["tenantRole"],
    };
  }

  /** Self-service password change. Other sessions are signed out so a leaked
   * password cannot keep access; the current session stays signed in. */
  async changePassword(
    actor: Principal,
    currentPassword: string,
    newPassword: string,
    currentToken: string,
  ) {
    const revoked = await this.db.transaction(async (tx) => {
      const [user] = await tx.query(
        "SELECT * FROM users WHERE id=$1 AND tenant_id=$2 AND active FOR UPDATE",
        [actor.id, actor.tenantId],
      );
      if (!user) throw notFound();
      if (!(await verifyPassword(currentPassword, text(user, "password_hash"))))
        throw new ApiError(401, "INVALID_CREDENTIALS", "当前密码不正确");
      if (await verifyPassword(newPassword, text(user, "password_hash")))
        throw new ApiError(409, "PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
      await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        await hashPassword(newPassword),
        actor.id,
      ]);
      const removed = await tx.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 RETURNING token_hash",
        [actor.id, sha256(currentToken)],
      );
      await this.access?.record(tx, actor, "account.password_changed", actor.id, {
        revokedSessions: removed.length,
      });
      return removed.length;
    });
    return { revoked };
  }

  async revokeOtherSessions(actor: Principal, currentToken: string) {
    const { revoked } = await this.db.transaction(async (tx) => {
      const removed = await tx.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 RETURNING token_hash",
        [actor.id, sha256(currentToken)],
      );
      await this.access?.record(tx, actor, "account.sessions_revoked", actor.id, {
        revoked: removed.length,
      });
      return { revoked: removed.length };
    });
    return { revoked };
  }
}
