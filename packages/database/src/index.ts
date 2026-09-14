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
    const agentApp = await readFile(new URL("./agent-app.sql", import.meta.url), "utf8");
    const assistantInteraction = await readFile(
      new URL("./assistant-interaction.sql", import.meta.url),
      "utf8",
    );
    const platformAssistant = await readFile(
      new URL("./platform-assistant.sql", import.meta.url),
      "utf8",
    );
    const knowledgeVersions = await readFile(
      new URL("./knowledge-versions.sql", import.meta.url),
      "utf8",
    );
    const skillSources = await readFile(new URL("./skill-sources.sql", import.meta.url), "utf8");
    const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    const knowledge = await readFile(new URL("./knowledge.sql", import.meta.url), "utf8");
    const mcp = await readFile(new URL("./mcp.sql", import.meta.url), "utf8");
    const workflows = await readFile(new URL("./workflows.sql", import.meta.url), "utf8");
    const pagination = await readFile(new URL("./pagination.sql", import.meta.url), "utf8");
    const skills = await readFile(new URL("./skills.sql", import.meta.url), "utf8");
    const conversationContext = await readFile(
      new URL("./conversation-context.sql", import.meta.url),
      "utf8",
    );
    const directories = await readFile(
      new URL("./resource-directories.sql", import.meta.url),
      "utf8",
    );
    const trajectoryObservability = await readFile(
      new URL("./trajectory-observability.sql", import.meta.url),
      "utf8",
    );
    const branches = await readFile(
      new URL("./conversation-branches.sql", import.meta.url),
      "utf8",
    );
    const longTasks = await readFile(new URL("./long-tasks.sql", import.meta.url), "utf8");
    const taskArtifacts = await readFile(new URL("./task-artifacts.sql", import.meta.url), "utf8");
    const budgetSettlement = await readFile(
      new URL("./model-budget-settlement.sql", import.meta.url),
      "utf8",
    );
    const taskFeedback = await readFile(new URL("./task-feedback.sql", import.meta.url), "utf8");
    const agentPreviews = await readFile(new URL("./agent-previews.sql", import.meta.url), "utf8");
    const teamAccess = await readFile(new URL("./team-access.sql", import.meta.url), "utf8");
    const conversationPins = await readFile(
      new URL("./conversation-pins.sql", import.meta.url),
      "utf8",
    );
    await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(2947301)");
      await tx.query(sql);
      const [applied] = await tx.query("SELECT version FROM schema_migrations WHERE version=2");
      if (!applied) await tx.query(knowledge);
      const [mcpApplied] = await tx.query("SELECT version FROM schema_migrations WHERE version=3");
      if (!mcpApplied) await tx.query(mcp);
      const [workflowApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=4",
      );
      if (!workflowApplied) await tx.query(workflows);
      const [paginationApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=5",
      );
      if (!paginationApplied) await tx.query(pagination);
      const [skillsApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=6",
      );
      if (!skillsApplied) await tx.query(skills);
      const [directoriesApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=7",
      );
      if (!directoriesApplied) await tx.query(directories);
      const [contextApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=8",
      );
      if (!contextApplied) await tx.query(conversationContext);
      const [trajectoryApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=9",
      );
      if (!trajectoryApplied) await tx.query(trajectoryObservability);
      const [branchesApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=10",
      );
      if (!branchesApplied) await tx.query(branches);
      const [longTasksApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=11",
      );
      if (!longTasksApplied) await tx.query(longTasks);
      const [artifactsApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=12",
      );
      if (!artifactsApplied) await tx.query(taskArtifacts);
      const [settlementApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=13",
      );
      if (!settlementApplied) await tx.query(budgetSettlement);
      const [feedbackApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=14",
      );
      if (!feedbackApplied) await tx.query(taskFeedback);
      const [accessApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=15",
      );
      if (!accessApplied) await tx.query(teamAccess);
      const [previewsApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=16",
      );
      if (!previewsApplied) await tx.query(agentPreviews);
      const [skillSourcesApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=17",
      );
      if (!skillSourcesApplied) await tx.query(skillSources);
      const [knowledgeVersionsApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=18",
      );
      if (!knowledgeVersionsApplied) await tx.query(knowledgeVersions);
      const [assistantApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=19",
      );
      if (!assistantApplied) await tx.query(platformAssistant);
      const [interactionApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=20",
      );
      if (!interactionApplied) await tx.query(assistantInteraction);
      const [agentAppApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=21",
      );
      if (!agentAppApplied) await tx.query(agentApp);
      const [pinsApplied] = await tx.query(
        "SELECT version FROM schema_migrations WHERE version=22",
      );
      if (!pinsApplied) await tx.query(conversationPins);
    });
  }
  async close() {
    await this.pool.end();
  }
}
