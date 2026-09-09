import { Credential, Id, z } from "./common.ts";
export const ModelInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseUrl: z.url().max(500),
    kind: z.enum(["chat", "embedding", "rerank"]).default("chat"),
    dimensions: z.number().int().min(1).max(16000).optional(),
    modelId: z.string().min(1).max(200),
    apiKey: Credential.default(""),
  })
  .strict()
  .openapi("ModelInput");
export const Model = ModelInput.omit({ apiKey: true })
  .extend({
    id: Id,
    projectId: Id,
    hasCredential: z.boolean(),
    createdAt: z.string(),
    provider: z.literal("openai-compatible"),
  })
  .openapi("Model");
export type ModelInput = z.input<typeof ModelInput>;
