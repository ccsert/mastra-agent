import type { OpenAPIHono } from "@hono/zod-openapi";
import { ErrorBody, Id, type Principal, z } from "@platform/contracts";
export type ApiApp = OpenAPIHono<{ Variables: { principal: Principal } }>;
export const projectParams = z.object({ projectId: Id }),
  itemParams = projectParams.extend({ id: Id });
export const json = <T extends z.ZodType>(schema: T) => ({
  description: "成功",
  content: { "application/json": { schema } },
});
export const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
export const errors = {
  400: json(ErrorBody),
  401: json(ErrorBody),
  403: json(ErrorBody),
  404: json(ErrorBody),
  409: json(ErrorBody),
  429: json(ErrorBody),
  503: json(ErrorBody),
};
