import { Id, z } from "./common.ts";
import { compileMcpSchema } from "./mcp-profile.ts";

const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const AgentAppData = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 24000, "应用数据超过 24000 字符");
export const AgentAppAction = z
  .object({
    id: name,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    effect: z.enum(["read", "view", "draft"]),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export const AgentAppManifest = z
  .object({
    protocolVersion: z.literal("1.0"),
    appId: name,
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(40),
    actions: z.array(AgentAppAction).min(1).max(40),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.actions.map((a) => a.id)).size !== value.actions.length)
      ctx.addIssue({ code: "custom", message: "动作 ID 重复" });
    for (const action of value.actions) {
      try {
        compileMcpSchema(action.inputSchema);
        compileMcpSchema(action.outputSchema);
      } catch {
        ctx.addIssue({ code: "custom", message: `动作 ${action.id} 的 schema 不受支持` });
      }
    }
  });
export type AgentAppManifest = z.infer<typeof AgentAppManifest>;
export const AgentAppView = z
  .object({
    appId: name,
    pageSessionId: Id,
    revision: Id,
    page: z.object({ id: name, title: z.string().max(200) }).strict(),
    ready: z.boolean(),
    summary: z.string().max(2000),
    state: AgentAppData,
    actions: z
      .array(
        z
          .object({ id: name, available: z.boolean(), reason: z.string().max(500).optional() })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type AgentAppView = z.infer<typeof AgentAppView>;
export const AgentAppInvocation = z
  .object({
    requestId: Id,
    action: name,
    expectedRevision: Id,
    args: AgentAppData,
  })
  .strict();
export type AgentAppInvocation = z.infer<typeof AgentAppInvocation>;
export const AgentAppOutcome = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    message: z.string().max(1000),
    code: z.string().max(80).optional(),
    output: AgentAppData,
    view: AgentAppView,
    uiApplied: z.boolean(),
    persistence: z.literal("not-requested"),
  })
  .strict();
export type AgentAppOutcome = z.infer<typeof AgentAppOutcome>;
export const AgentAppRegistration = z
  .object({
    url: z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
      }, "应用地址需要 HTTPS；本地示例可使用 loopback HTTP"),
    manifest: AgentAppManifest,
  })
  .strict();
export const AgentAppRegistrationView = AgentAppRegistration.extend({ id: Id });
export type AgentAppRegistrationView = z.infer<typeof AgentAppRegistrationView>;
export const AgentAppSyncInput = z
  .object({
    registrationId: Id,
    clientId: Id,
    enabled: z.boolean(),
    grant: z.boolean().default(false),
    allowDraft: z.boolean().default(false),
    view: AgentAppView,
  })
  .strict();
export const AgentAppReceipt = z.object({
  id: Id,
  status: z.enum(["pending", "executing", "succeeded", "failed", "cancelled", "unknown"]),
  input: AgentAppInvocation,
  result: AgentAppOutcome.nullable(),
});
export type AgentAppReceipt = z.infer<typeof AgentAppReceipt>;
export const AgentAppSync = z.object({ active: z.boolean(), action: AgentAppReceipt.nullable() });
export const AgentAppCompletion = z.object({ clientId: Id, result: AgentAppOutcome }).strict();
export const AgentAppToolInput = z
  .object({
    operation: z.enum(["inspect", "describe", "act", "result"]),
    action: name.optional(),
    expectedRevision: Id.optional(),
    args: AgentAppData.optional(),
    actionId: Id.optional(),
  })
  .strict();
