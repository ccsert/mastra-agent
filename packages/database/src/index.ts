import { readFile } from "node:fs/promises";
import pg from "pg";
export type Row = Record<string, unknown>;
export interface Queryable {
  query<T extends pg.QueryResultRow = Row>(sql: string, values?: unknown[]): Promise<T[]>;
}
export class Database implements Queryable {
  readonly pool: pg.Pool;
  constructor(url: string, schema = "public") {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid database schema");
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      options: `-c search_path=${schema},public`,
    });
  }
  async query<T extends pg.QueryResultRow = Row>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query<T>(sql, values)).rows;
  }
  async transaction<T>(action: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await action({
        query: async <R extends pg.QueryResultRow = Row>(sql: string, values: unknown[] = []) =>
          (await client.query<R>(sql, values)).rows,
      });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate() {
    const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    const knowledge = await readFile(new URL("./knowledge.sql", import.meta.url), "utf8");
    const mcp = await readFile(new URL("./mcp.sql", import.meta.url), "utf8");
    await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(2947301)");
      await tx.query(sql);
      const [applied] = await tx.query("SELECT version FROM schema_migrations WHERE version=2");
      if (!applied) await tx.query(knowledge);
      const [mcpApplied] = await tx.query("SELECT version FROM schema_migrations WHERE version=3");
      if (!mcpApplied) await tx.query(mcp);
    });
  }
  async close() {
    await this.pool.end();
  }
}
