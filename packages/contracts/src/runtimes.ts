import { z } from "./common.ts";
export const RuntimeInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    lastSeenAt: z.string().nullable(),
    online: z.boolean(),
  })
  .openapi("RuntimeInfo");
