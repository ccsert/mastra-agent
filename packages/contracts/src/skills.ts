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
  extensionFields: z.array(z.string()).optional(),
});
export const SkillRemoteSource = z.object({
  kind: z.enum(["github", "gitlab", "skills-sh"]),
  url: z.string(),
  repository: z.string(),
  ref: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.union([z.literal(""), SkillPath]),
});
export const SkillSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zip"), fileName: z.string() }),
  SkillRemoteSource,
]);
export const SkillVersion = SkillManifest.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  version: z.number().int().positive(),
  digest: z.string(),
  archiveHash: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  source: SkillSource.nullable().optional(),
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
export const SkillSourceInput = z
  .object({
    url: z.string().trim().min(1).max(1000),
    ref: z.string().trim().min(1).max(240).optional(),
    path: z.union([z.literal(""), SkillPath]).optional(),
  })
  .strict()
  .openapi("SkillSourceInput");
export const SkillDiscovery = z
  .object({
    source: SkillRemoteSource,
    candidates: z.array(
      z.object({
        path: z.union([z.literal(""), SkillPath]),
        name: z.string(),
        fileCount: z.number().int(),
      }),
    ),
  })
  .openapi("SkillDiscovery");
export const SkillPreviewInput = z
  .discriminatedUnion("kind", [
    SkillUpload.extend({
      kind: z.literal("zip"),
      fileName: z.string().max(240).default("skill.zip"),
    }),
    z
      .object({
        kind: z.literal("remote"),
        source: SkillSourceInput,
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.union([z.literal(""), SkillPath]),
      })
      .strict(),
  ])
  .openapi("SkillPreviewInput");
export const SkillImportPreview = z
  .object({
    id: z.uuid(),
    expiresAt: z.string(),
    source: SkillSource,
    manifest: SkillManifest,
    digest: z.string(),
    baseVersion: SkillVersion.omit({}).nullable(),
    existingVersion: SkillVersion.omit({}).nullable(),
    changes: z.array(z.object({ path: SkillPath, kind: z.enum(["added", "modified", "removed"]) })),
  })
  .openapi("SkillImportPreview");
export const SkillImportResult = z
  .object({ skill: SkillVersion, reused: z.boolean() })
  .openapi("SkillImportResult");
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
export type SkillSource = z.infer<typeof SkillSource>;
export type SkillRemoteSource = z.infer<typeof SkillRemoteSource>;
export type SkillSourceInput = z.infer<typeof SkillSourceInput>;
export type SkillDiscovery = z.infer<typeof SkillDiscovery>;
export type SkillPreviewInput = z.infer<typeof SkillPreviewInput>;
export type SkillImportPreview = z.infer<typeof SkillImportPreview>;
