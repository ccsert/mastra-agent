import { z } from "@hono/zod-openapi";

export { z };
export const Id = z.uuid();
export const PageQuery = z.object({
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const ErrorBody = z.object({ code: z.string(), message: z.string() }).openapi("ApiError");
export const Credential = z.string().max(4096);
export const JsonSchema = z.record(z.string(), z.unknown()).openapi("JsonSchema");
export const RunStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
