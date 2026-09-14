import { TenantRole } from "./access.ts";
import { Id, z } from "./common.ts";
export const Application = z
  .object({
    id: Id,
    projectId: Id,
    name: z.string(),
    accessKey: z.string(),
    active: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Application");
export const Principal = z
  .object({
    id: Id,
    tenantId: Id,
    displayName: z.string(),
    kind: z.enum(["user", "application"]),
    projectId: Id.optional(),
    entry: z.string(),
    tenantRole: TenantRole.optional(),
  })
  .openapi("Principal");
export type Principal = z.infer<typeof Principal>;
