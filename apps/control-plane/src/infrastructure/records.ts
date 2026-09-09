import type { Row } from "@platform/database";
export const text = (r: Row, key: string) => String(r[key]);
export const date = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);
export const data = (r: Row) => r.data as Record<string, unknown>;
