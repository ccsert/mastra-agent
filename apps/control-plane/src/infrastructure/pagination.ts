import { createHash } from "node:crypto";
import { Id, PageQuery, z } from "@platform/contracts";
import type { Row } from "@platform/database";
import { ApiError } from "./errors.ts";

export type PageInput = { cursor?: string; limit?: number };
export type Page<T> = { items: T[]; nextCursor: string | null };
const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    id: Id,
    // Preserve PostgreSQL microseconds; a JavaScript Date would skip records within the same ms.
    time: z.string(),
  })
  .strict();

/** Descending immutable creation order. The cursor is a position, never an authorization grant. */
export function cursorPage(
  scope: string[],
  input: PageInput = {},
  defaultLimit = 100,
  order: "created_at" | "version" = "created_at",
) {
  const query = PageQuery.parse(input),
    limit = query.limit ?? defaultLimit;
  const binding = createHash("sha256")
    .update(JSON.stringify([...scope, order]))
    .digest("hex");
  let after: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      after = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      const valid =
        order === "version"
          ? /^[1-9][0-9]*$/.test(after.time) && Number(after.time) <= 2147483647
          : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.time) &&
            Number.isFinite(Date.parse(after.time));
      if (after.scope !== binding || !valid) throw new Error();
    } catch {
      throw new ApiError(400, "INVALID_CURSOR", "分页游标无效或不属于当前列表，请从第一页重新读取");
    }
  }
  return {
    limit,
    // Columns and parameter positions come only from module-owned SQL, never request data.
    select: (alias: string) =>
      order === "version"
        ? `${alias}.version::text AS cursor_time`
        : `to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`,
    where: (alias: string, parameter: number) =>
      `($${parameter}::${order === "version" ? "int" : "timestamptz"} IS NULL OR (${alias}.${order},${alias}.id)<($${parameter}::${order === "version" ? "int" : "timestamptz"},$${parameter + 1}::uuid))`,
    values: [after?.time ?? null, after?.id ?? null, limit + 1],
    result<T>(rows: Row[], map: (row: Row) => T): Page<T> {
      const visible = rows.slice(0, limit),
        last = visible.at(-1);
      return {
        items: visible.map(map),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  scope: binding,
                  id: last.id,
                  time: last.cursor_time,
                }),
              ).toString("base64url")
            : null,
      };
    },
  };
}
