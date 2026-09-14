import { randomUUID } from "node:crypto";
import {
  type AgentAppCompletion,
  AgentAppManifest,
  AgentAppReceipt,
  type AgentAppSyncInput,
  AgentAppToolInput,
  AgentAppView,
  AssistantUiView,
  canonicalJson,
  compileMcpSchema,
  type Permission,
  platformAppManifest,
  platformAppOperations,
  platformAppRegistrationId,
  type z,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";
import { checkAction } from "./ui.ts";

export const builtinApp = {
  id: platformAppRegistrationId,
  url: "https://platform.invalid/",
  manifest: platformAppManifest,
};
const receipt = (row: Row) => AgentAppReceipt.parse(row);
const lock = (tx: Queryable, id: string) =>
  tx.query(
    "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 FOR UPDATE",
    [id],
  );
export async function appRegistration(tx: Queryable, projectId: string, id: string) {
  if (id === platformAppRegistrationId) return builtinApp;
  const [row] = await tx.query(
    "SELECT * FROM assistant_app_registrations WHERE id=$1 AND project_id=$2",
    [id, projectId],
  );
  if (!row) throw notFound();
  return {
    id: String(row.id),
    url: String(row.url),
    manifest: AgentAppManifest.parse(row.manifest),
  };
}
function check(
  permissions: Permission[],
  registrationId: string,
  manifest: AgentAppManifest,
  view: AgentAppView,
  actionId?: string,
  args: Record<string, unknown> = {},
  allowDraft = false,
) {
  if (
    !permissions.includes(
      registrationId === platformAppRegistrationId ? "project.read" : "resource.read",
    )
  )
    throw new ApiError(403, "FORBIDDEN", "没有访问此应用的权限");
  if (
    manifest.appId !== view.appId ||
    view.actions.some((a) => !manifest.actions.some((m) => m.id === a.id))
  )
    throw new ApiError(409, "APP_MANIFEST_CHANGED", "页面声明与登记的应用不匹配");
  if (registrationId === platformAppRegistrationId) {
    const internal = AssistantUiView.parse(view.state.platform);
    // inspect itself is permission checked, including the currently displayed resource.
    checkAction(
      { operation: "inspect" },
      internal as Parameters<typeof checkAction>[1],
      permissions,
    );
  }
  if (!actionId) return;
  const action = manifest.actions.find((a) => a.id === actionId);
  if (!action || !view.ready || !view.actions.some((a) => a.id === actionId && a.available))
    throw new ApiError(409, "ACTION_UNAVAILABLE", "动作不可用，请重新读取当前页面");
  if (
    action.effect === "draft" &&
    (!allowDraft ||
      !permissions.includes(
        registrationId === platformAppRegistrationId ? "agent.edit" : "resource.edit",
      ))
  )
    throw new ApiError(403, "DRAFT_NOT_GRANTED", "当前用户权限或会话授权不允许修改草稿");
  if (!compileMcpSchema(action.inputSchema)(args))
    throw new ApiError(400, "INVALID_APP_INPUT", "输入不符合登记的动作规范");
  if (registrationId === platformAppRegistrationId)
    for (const operation of platformAppOperations(actionId, args, view.state.platform))
      checkAction(operation, view.state.platform as Parameters<typeof checkAction>[1], permissions);
}
async function expire(tx: Queryable, conversationId: string) {
  await tx.query(
    `UPDATE assistant_app_actions a SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE 'unknown' END,
    result=jsonb_build_object('status',CASE WHEN status='pending' THEN 'cancelled' ELSE 'unknown' END,'message','页面连接、运行或动作已过期；执行中的结果无法确认，不会自动重放','code','CONNECTION_EXPIRED','output','{}'::jsonb,'view',a.view,'uiApplied',false,'persistence','not-requested')
    WHERE a.conversation_id=$1 AND a.status IN ('pending','executing') AND
    (a.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM assistant_app_sessions s WHERE s.conversation_id=a.conversation_id AND s.client_id=a.client_id AND s.registration_id=a.registration_id AND s.page_session_id=a.page_session_id AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=a.run_id AND r.status='running' AND NOT r.cancel_requested AND r.lease_until>clock_timestamp() AND r.deadline>clock_timestamp()))`,
    [conversationId],
  );
}
export async function syncApp(
  db: Database,
  projectId: string,
  conversationId: string,
  permissions: Permission[],
  input: z.infer<typeof AgentAppSyncInput>,
) {
  return db.transaction(async (tx) => {
    await lock(tx, conversationId);
    if (!input.enabled) {
      await tx.query(
        "DELETE FROM assistant_app_sessions WHERE conversation_id=$1 AND client_id=$2",
        [conversationId, input.clientId],
      );
      await expire(tx, conversationId);
      return { active: false, action: null };
    }
    // Expire before renewing, so an absent client cannot revive an executing action.
    await expire(tx, conversationId);
    const registration = await appRegistration(tx, projectId, input.registrationId);
    check(permissions, input.registrationId, registration.manifest, input.view);
    if (
      input.allowDraft &&
      !permissions.includes(
        input.registrationId === platformAppRegistrationId ? "agent.edit" : "resource.edit",
      )
    )
      throw new ApiError(403, "DRAFT_NOT_GRANTED", "当前角色不能修改草稿");
    const [other] = await tx.query(
      "SELECT 1 FROM assistant_ui_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (other) throw new ApiError(409, "UI_IN_USE", "请先停止旧的页面协作");
    const [previous] = await tx.query(
      "SELECT * FROM assistant_app_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (
      previous &&
      (previous.client_id !== input.clientId ||
        previous.registration_id !== input.registrationId ||
        previous.page_session_id !== input.view.pageSessionId ||
        previous.allow_draft !== input.allowDraft)
    )
      throw new ApiError(409, "APP_IN_USE", "此任务已连接其他页面或授权已变化，请先停止原连接");
    if (!previous && !input.grant) return { active: false, action: null };
    await tx.query(
      `INSERT INTO assistant_app_sessions(conversation_id,registration_id,client_id,page_session_id,allow_draft,expires_at,view) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '8 seconds',$6)
      ON CONFLICT(conversation_id) DO UPDATE SET registration_id=excluded.registration_id,client_id=excluded.client_id,page_session_id=excluded.page_session_id,allow_draft=excluded.allow_draft,expires_at=excluded.expires_at,view=excluded.view`,
      [
        conversationId,
        input.registrationId,
        input.clientId,
        input.view.pageSessionId,
        input.allowDraft,
        input.view,
      ],
    );
    const [busy] = await tx.query(
      "SELECT 1 FROM assistant_app_actions WHERE conversation_id=$1 AND status='executing'",
      [conversationId],
    );
    if (busy) return { active: true, action: null };
    const [next] = await tx.query(
      "SELECT * FROM assistant_app_actions WHERE conversation_id=$1 AND client_id=$2 AND status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE",
      [conversationId, input.clientId],
    );
    if (!next) return { active: true, action: null };
    const action = receipt(next);
    try {
      check(
        permissions,
        input.registrationId,
        registration.manifest,
        input.view,
        action.input.action,
        action.input.args,
        input.allowDraft,
      );
      if (action.input.expectedRevision !== input.view.revision)
        throw new ApiError(409, "STALE_REVISION", "用户或页面已更改状态，请重新读取");
    } catch (error) {
      await tx.query("UPDATE assistant_app_actions SET status='failed',result=$2 WHERE id=$1", [
        next.id,
        {
          status: "failed",
          code: error instanceof ApiError ? error.code : "INVALID_ACTION",
          message: error instanceof Error ? error.message : "动作无效",
          output: {},
          view: input.view,
          uiApplied: false,
          persistence: "not-requested",
        },
      ]);
      return { active: true, action: null };
    }
    await tx.query("UPDATE assistant_app_actions SET status='executing' WHERE id=$1", [next.id]);
    return { active: true, action: { ...action, status: "executing" as const } };
  });
}
export async function requestApp(
  db: Database,
  projectId: string,
  conversationId: string,
  runId: string,
  toolCallId: string,
  permissions: Permission[],
  raw: Record<string, unknown>,
) {
  const input = AgentAppToolInput.parse(raw);
  if (
    (input.operation === "act" && (!input.action || !input.expectedRevision || !input.args)) ||
    (input.operation === "describe" && !input.action) ||
    (input.operation === "result" && !input.actionId)
  )
    throw new ApiError(400, "INVALID_APP_INPUT", "动作缺少必需参数");
  return db.transaction(async (tx) => {
    await lock(tx, conversationId);
    await expire(tx, conversationId);
    if (input.operation === "result") {
      const [row] = await tx.query(
        "SELECT * FROM assistant_app_actions WHERE id=$1 AND conversation_id=$2 AND run_id=$3",
        [input.actionId, conversationId, runId],
      );
      if (!row) throw notFound();
      return receipt(row);
    }
    if (input.operation === "act") {
      const [prior] = await tx.query(
        "SELECT * FROM assistant_app_actions WHERE run_id=$1 AND tool_call_id=$2",
        [runId, toolCallId],
      );
      if (prior) {
        if (canonicalJson(prior.request) !== canonicalJson(input))
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同一调用不能更换动作内容");
        return receipt(prior);
      }
    }
    const [session] = await tx.query(
      "SELECT * FROM assistant_app_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (!session)
      throw new ApiError(
        409,
        "APP_NOT_CONNECTED",
        "请用户在任务台打开应用协作，选择应用并连接当前页面",
      );
    const view = AgentAppView.parse(session.view),
      registration = await appRegistration(tx, projectId, String(session.registration_id));
    check(permissions, registration.id, registration.manifest, view);
    if (input.operation === "inspect")
      return {
        type: "agent-app-view",
        application: registration.manifest.name,
        ...view,
        grants: { allowDraft: session.allow_draft },
        actions: registration.manifest.actions.map(
          ({ inputSchema: _, outputSchema: __, ...a }) => ({
            ...a,
            available:
              view.actions.some((v) => v.id === a.id && v.available) &&
              (a.effect !== "draft" || session.allow_draft === true),
          }),
        ),
      };
    if (input.operation === "describe") {
      const action = registration.manifest.actions.find((a) => a.id === input.action);
      if (!action) throw notFound();
      return { type: "agent-app-action", ...action };
    }
    check(
      permissions,
      registration.id,
      registration.manifest,
      view,
      input.action,
      input.args,
      session.allow_draft === true,
    );
    if (view.revision !== input.expectedRevision)
      throw new ApiError(409, "STALE_REVISION", "页面已变化，请重新 inspect");
    const [busy] = await tx.query(
      "SELECT 1 FROM assistant_app_actions WHERE conversation_id=$1 AND status IN ('pending','executing')",
      [conversationId],
    );
    if (busy) throw new ApiError(409, "APP_BUSY", "请等待当前动作回执");
    const id = randomUUID(),
      invocation = {
        requestId: id,
        action: input.action,
        args: input.args,
        expectedRevision: input.expectedRevision,
      };
    const [row] = await tx.query(
      "INSERT INTO assistant_app_actions(id,conversation_id,run_id,tool_call_id,registration_id,client_id,page_session_id,input,request,view) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [
        id,
        conversationId,
        runId,
        toolCallId,
        registration.id,
        session.client_id,
        session.page_session_id,
        invocation,
        input,
        view,
      ],
    );
    return receipt(row);
  });
}
export async function completeApp(
  db: Database,
  projectId: string,
  conversationId: string,
  actionId: string,
  permissions: Permission[],
  input: z.infer<typeof AgentAppCompletion>,
) {
  return db.transaction(async (tx) => {
    await lock(tx, conversationId);
    await expire(tx, conversationId);
    const [row] = await tx.query(
      "SELECT * FROM assistant_app_actions WHERE id=$1 AND conversation_id=$2 AND client_id=$3",
      [actionId, conversationId, input.clientId],
    );
    if (!row) throw notFound();
    if (row.status !== "executing") return receipt(row);
    const action = receipt(row),
      registration = await appRegistration(tx, projectId, String(row.registration_id));
    const [session] = await tx.query(
      "SELECT * FROM assistant_app_sessions WHERE conversation_id=$1",
      [conversationId],
    );
    check(
      permissions,
      registration.id,
      registration.manifest,
      AgentAppView.parse(row.view),
      action.input.action,
      action.input.args,
      session?.allow_draft === true,
    );
    check(permissions, registration.id, registration.manifest, input.result.view);
    if (input.result.view.pageSessionId !== row.page_session_id)
      throw new ApiError(409, "APP_SESSION_CHANGED", "回执来自另一个页面实例");
    const definition = registration.manifest.actions.find((a) => a.id === action.input.action);
    if (
      input.result.status === "succeeded" &&
      (!input.result.uiApplied ||
        !definition ||
        !compileMcpSchema(definition.outputSchema)(input.result.output))
    )
      throw new ApiError(400, "INVALID_APP_OUTPUT", "成功回执不符合登记的动作规范");
    await tx.query("UPDATE assistant_app_actions SET status=$2,result=$3 WHERE id=$1", [
      actionId,
      input.result.status,
      input.result,
    ]);
    await tx.query("UPDATE assistant_app_sessions SET view=$2 WHERE conversation_id=$1", [
      conversationId,
      input.result.view,
    ]);
    return { ...action, status: input.result.status, result: input.result };
  });
}
