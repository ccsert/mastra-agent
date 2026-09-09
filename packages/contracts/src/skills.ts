import { z } from "@hono/zod-openapi";

export const SkillPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !/[\\:]/.test(path) &&
      [...path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      path.split("/").every((p) => p && p !== "." && p !== ".."),
    "文件路径必须是包内相对路径",
  );
export const SkillBinding = z
  .object({
    versionId: z.uuid(),
    entrypoints: z.array(SkillPath).max(30).default([]),
  })
  .strict()
  .openapi("SkillBinding");
export const SkillFile = z.object({
  path: SkillPath,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(2097152),
  encoding: z.enum(["utf-8", "base64"]),
});
export const SkillManifest = z.object({
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  allowedTools: z.string().optional(),
  files: z.array(SkillFile).min(1).max(200),
  entrypoints: z.array(SkillPath),
  warnings: z.array(z.string()),
});
export const SkillVersion = SkillManifest.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  version: z.number().int().positive(),
  digest: z.string(),
  archiveHash: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
}).openapi("SkillVersion");
export const SkillSnapshot = SkillVersion.omit({ enabled: true }).extend({
  authorizedEntrypoints: z.array(SkillPath),
});
export const SkillUpload = z
  .object({
    archiveBase64: z.string().min(1).max(5592408),
  })
  .strict()
  .openapi("SkillUpload");
export const SkillFileContent = z
  .object({ path: SkillPath, contentBase64: z.string(), hash: z.string() })
  .openapi("SkillFileContent");
export const SkillAccessRequest = z
  .object({
    leaseToken: z.string(),
    versionId: z.uuid(),
    operation: z.enum(["check", "read", "execute"]),
    path: SkillPath.optional(),
  })
  .strict();
export const SkillErrorCode = z.enum([
  "SKILL_ACCESS_DENIED",
  "SKILL_CONTENT_INVALID",
  "SKILL_SANDBOX_UNAVAILABLE",
  "SKILL_SCRIPT_FAILED",
  "SKILL_OUTPUT_LIMIT",
  "SKILL_INPUT_LIMIT",
  "SKILL_CALL_LIMIT",
  "SKILL_TIMEOUT",
  "SKILL_CLEANUP_FAILED",
]);
export type SkillBinding = z.infer<typeof SkillBinding>;
export type SkillManifest = z.infer<typeof SkillManifest>;
export type SkillVersion = z.infer<typeof SkillVersion>;
export type SkillSnapshot = z.infer<typeof SkillSnapshot>;
export type SkillAccessRequest = z.infer<typeof SkillAccessRequest>;
