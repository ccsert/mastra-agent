import { randomBytes, randomUUID } from "node:crypto";
import type { Principal } from "@platform/contracts";
import type { Database } from "@platform/database";
import { hashPassword, sha256, verifyPassword } from "../../infrastructure/crypto.ts";
import { ApiError } from "../../infrastructure/errors.ts";
import { text } from "../../infrastructure/records.ts";
export class Identity {
  constructor(private readonly db: Database) {}
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
        "INSERT INTO users(id,tenant_id,username,display_name,password_hash) VALUES($1,$2,$3,$4,$5)",
        [userId, tenantId, username, username, passwordHash],
      );
      return { tenantId, userId };
    });
  }
  async login(username: string, password: string) {
    const [user] = await this.db.query("SELECT * FROM users WHERE username=$1", [username]);
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
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [sha256(token)],
    );
    if (!r) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
    return {
      id: text(r, "id"),
      tenantId: text(r, "tenant_id"),
      displayName: text(r, "display_name"),
      kind: "user",
      entry: "console",
    };
  }
}
