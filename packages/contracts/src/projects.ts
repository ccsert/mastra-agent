import { Id, z } from "./common.ts";
export const ProjectInput = z
  .object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default("") })
  .strict()
  .openapi("ProjectInput");
export const Project = ProjectInput.extend({ id: Id, tenantId: Id, createdAt: z.string() }).openapi(
  "Project",
);
