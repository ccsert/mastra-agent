import { z } from "./common.ts";
export const RuntimeInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    lastSeenAt: z.string().nullable(),
    online: z.boolean(),
    enabled: z.boolean(),
    /** The control plane's own configured runtime; it cannot be deleted. */
    builtIn: z.boolean(),
  })
  .openapi("RuntimeInfo");
export const RuntimeRegisterInput = z
  .object({
    name: z.string().trim().min(1).max(60),
  })
  .strict()
  .openapi("RuntimeRegister");
export const RuntimeRegistered = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Shown once at registration; only its hash is stored. */
    token: z.string(),
  })
  .openapi("RuntimeRegistered");
export type RuntimeRegistered = z.infer<typeof RuntimeRegistered>;
export const RuntimeUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.enabled !== undefined, {
    message: "至少提供 name 或 enabled 之一",
  })
  .openapi("RuntimeUpdate");
