import { randomUUID } from "node:crypto";
import {
  AssistantUiOperation,
  AssistantUiReceipt,
  type AssistantUiResultInput,
  type AssistantUiSyncInput,
  type AssistantUiView,
  type Permission,
  type z,
} from "@platform/contracts";
import type { Database, Queryable, Row } from "@platform/database";
import { ApiError, notFound } from "../../infrastructure/errors.ts";

export const assistantPagePermissions: Record<z.infer<typeof AssistantUiView>["page"], Permission> =
  {
    overview: "project.read",
    agents: "project.read",
    chat: "agent.run",
    skills: "resource.read",
    knowledge: "resource.read",
    workflows: "resource.edit",
    models: "resource.manage",
    tools: "resource.read",
    mcp: "resource.manage",
    runs: "project.read",
    applications: "resource.manage",
    runtimes: "project.read",
    settings: "project.manage",
    team: "project.manage",
  };
const receipt = (r: Row) =>
  AssistantUiReceipt.parse({ id: r.id, status: r.status, input: r.input, result: r.result });
function checkView(view: z.infer<typeof AssistantUiView>, permissions: Permission[]) {
  if (
    !permissions.includes(assistantPagePermissions[view.page]) ||
    (view.page === "agents" && view.resourceId && !permissions.includes("resource.read"))
  )
    throw new ApiError(403, "FORBIDDEN", "当前权限不能操作目标页面");
}
export function checkAction(
  input: z.infer<typeof AssistantUiOperation>,
  view: z.infer<typeof AssistantUiView>,
  permissions: Permission[],
) {
  checkView(view, permissions);
  if (input.operation === "navigate") {
    checkView({ ...input, ready: true, revision: input.viewRevision, targets: [] }, permissions);
    // Team administration has a separate tenant-level boundary. Use a reviewed entry instead.
    if (input.page === "team") throw new ApiError(403, "FORBIDDEN", "团队管理请由用户打开");
  }
  if (input.operation === "act") {
    if (!view.ready) throw new ApiError(409, "UI_LOADING", "当前页面仍在加载，请稍后重新 inspect");
    if (!view.targets.some((target) => target.id === input.target))
      throw new ApiError(409, "UI_TARGET_UNAVAILABLE", "当前页面没有这个操作目标，请重新 inspect");
    if (
      input.target.startsWith("agent.") &&
      (view.page !== "agents" || !permissions.includes("agent.edit"))
    )
      throw new ApiError(403, "FORBIDDEN", "没有修改 Agent 草稿的权限");
    if (
      !input.target.startsWith("agent.") &&
      (!["tools", "skills"].includes(view.page) || !permissions.includes("resource.read"))
    )
      throw new ApiError(403, "FORBIDDEN", "没有访问能力目录的权限");
    if (
      (input.target === "agent.name" && (input.value?.length ?? 0) > 80) ||
      (input.target === "agent.description" && (input.value?.length ?? 0) > 500)
    )
      throw new ApiError(400, "UI_VALUE_INVALID", "字段内容超过长度限制");
    const target = view.targets.find((target) => target.id === input.target);
    if (target?.options && !target.options.includes(input.value ?? ""))
      throw new ApiError(400, "UI_VALUE_INVALID", "值不在当前可选项中");
    if (target?.kind !== "click" && input.value === undefined)
      throw new ApiError(400, "UI_VALUE_INVALID", "请提供字段值");
  }
}
async function expire(tx: Queryable, conversationId: string) {
  await tx.query(
    `UPDATE assistant_ui_actions a SET status='failed',result='{"message":"页面动作已过期、被停止或运行已结束；结果不可确认，不会自动重放"}'::jsonb
    WHERE a.conversation_id=$1 AND a.status IN ('pending','executing') AND
    (a.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM assistant_ui_sessions s WHERE s.conversation_id=a.conversation_id AND s.client_id=a.client_id AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=a.run_id AND r.status='running' AND NOT r.cancel_requested AND r.lease_until>clock_timestamp() AND r.deadline>clock_timestamp()))`,
    [conversationId],
  );
}

export async function syncUi(
  db: Database,
  conversationId: string,
  permissions: Permission[],
  input: z.infer<typeof AssistantUiSyncInput>,
) {
  return db.transaction(async (tx) => {
    // Serialize grant/revoke/claims for one session, including the initial absent lease.
    await tx.query(
      "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 FOR UPDATE",
      [conversationId],
    );
    if (!input.enabled) {
      await tx.query(
        "DELETE FROM assistant_ui_sessions WHERE conversation_id=$1 AND client_id=$2",
        [conversationId, input.clientId],
      );
      await expire(tx, conversationId);
      return { active: false, action: null };
    }
    checkView(input.view, permissions);
    const [other] = await tx.query(
      "SELECT 1 FROM assistant_app_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (other) throw new ApiError(409, "UI_IN_USE", "请先停止应用协作");
    await expire(tx, conversationId);
    const [previous] = await tx.query(
      "SELECT * FROM assistant_ui_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (previous && previous.client_id !== input.clientId)
      throw new ApiError(409, "UI_IN_USE", "此任务已在另一窗口开启页面协作，请先在原窗口停止");
    if (!previous && !input.grant) {
      await expire(tx, conversationId);
      return { active: false, action: null };
    }
    await tx.query(
      `INSERT INTO assistant_ui_sessions(conversation_id,client_id,expires_at,view) VALUES($1,$2,now()+interval '8 seconds',$3)
      ON CONFLICT(conversation_id) DO UPDATE SET client_id=excluded.client_id,expires_at=excluded.expires_at,view=excluded.view`,
      [conversationId, input.clientId, input.view],
    );
    await expire(tx, conversationId);
    const [action] = await tx.query(
      "SELECT * FROM assistant_ui_actions WHERE conversation_id=$1 AND client_id=$2 AND status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE",
      [conversationId, input.clientId],
    );
    if (!action) return { active: true, action: null };
    const operation = AssistantUiOperation.parse(action.input);
    try {
      checkAction(operation, input.view, permissions);
      if (!("viewRevision" in operation) || operation.viewRevision !== input.view.revision)
        throw new ApiError(409, "UI_VIEW_CHANGED", "页面已变化，请重新 inspect 后操作");
    } catch (error) {
      await tx.query("UPDATE assistant_ui_actions SET status='failed',result=$2 WHERE id=$1", [
        action.id,
        { message: error instanceof ApiError ? error.message : "页面动作无效" },
      ]);
      return { active: true, action: null };
    }
    await tx.query("UPDATE assistant_ui_actions SET status='executing' WHERE id=$1", [action.id]);
    return { active: true, action: receipt({ ...action, status: "executing" }) };
  });
}

export async function requestUi(
  db: Database,
  conversationId: string,
  runId: string,
  toolCallId: string,
  permissions: Permission[],
  raw: Record<string, unknown>,
) {
  const input = AssistantUiOperation.parse(raw);
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 FOR UPDATE",
      [conversationId],
    );
    await expire(tx, conversationId);
    if (input.operation === "result") {
      const [action] = await tx.query(
        "SELECT * FROM assistant_ui_actions WHERE id=$1 AND conversation_id=$2 AND run_id=$3",
        [input.actionId, conversationId, runId],
      );
      if (!action) throw notFound();
      return receipt(action);
    }
    const [session] = await tx.query(
      "SELECT * FROM assistant_ui_sessions WHERE conversation_id=$1 AND expires_at>clock_timestamp()",
      [conversationId],
    );
    if (!session)
      throw new ApiError(409, "UI_NOT_CONNECTED", "请用户在任务台开启页面协作，并保持当前窗口可见");
    const view = session.view as z.infer<typeof AssistantUiView>;
    checkAction(input, view, permissions);
    if (input.operation === "inspect") return { type: "platform-ui-view", ...view };
    const [prior] = await tx.query(
      "SELECT * FROM assistant_ui_actions WHERE run_id=$1 AND tool_call_id=$2",
      [runId, toolCallId],
    );
    if (prior) {
      if (
        JSON.stringify(prior.input) !== JSON.stringify(input) &&
        JSON.stringify(prior.input, Object.keys(input).sort()) !==
          JSON.stringify(input, Object.keys(input).sort())
      )
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "动作标识已用于不同内容");
      return receipt(prior);
    }
    if (input.viewRevision !== view.revision)
      throw new ApiError(409, "UI_VIEW_CHANGED", "页面已变化，请重新 inspect");
    const [action] = await tx.query(
      "INSERT INTO assistant_ui_actions(id,conversation_id,run_id,tool_call_id,client_id,input) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [randomUUID(), conversationId, runId, toolCallId, session.client_id, input],
    );
    return receipt(action);
  });
}

export async function completeUi(
  db: Database,
  conversationId: string,
  actionId: string,
  permissions: Permission[],
  input: z.infer<typeof AssistantUiResultInput>,
) {
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT conversation_id FROM platform_assistant_sessions WHERE conversation_id=$1 FOR UPDATE",
      [conversationId],
    );
    await expire(tx, conversationId);
    const [action] = await tx.query(
      "SELECT * FROM assistant_ui_actions WHERE id=$1 AND conversation_id=$2 AND client_id=$3 FOR UPDATE",
      [actionId, conversationId, input.clientId],
    );
    if (!action) throw notFound();
    if (action.status !== "executing") return receipt(action);
    checkView(input.view, permissions);
    // Permission changes between claim and acknowledgment must not turn into a success receipt.
    const operation = AssistantUiOperation.parse(action.input);
    if (
      operation.operation === "act" &&
      operation.target.startsWith("agent.") &&
      !permissions.includes("agent.edit")
    )
      throw new ApiError(403, "FORBIDDEN", "Agent 编辑权限已撤销");
    const result = { message: input.message, view: input.view };
    await tx.query("UPDATE assistant_ui_actions SET status=$2,result=$3 WHERE id=$1", [
      actionId,
      input.status,
      result,
    ]);
    await tx.query(
      "UPDATE assistant_ui_sessions SET view=$3 WHERE conversation_id=$1 AND client_id=$2",
      [conversationId, input.clientId, input.view],
    );
    return receipt({ ...action, status: input.status, result });
  });
}
