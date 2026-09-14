import {
  AssistantCapabilities,
  AssistantOperationDetail,
  assistantToolDefinitions,
  z,
} from "@platform/contracts";
import type { Database } from "@platform/database";
import { sha256 } from "../../infrastructure/crypto.ts";
import { notFound } from "../../infrastructure/errors.ts";
import type { Operation } from "./operations.ts";
import { assistantSkills } from "./skills.ts";

const names: Record<string, string> = {
  platform_app: "操作连接的应用",
  platform_ui: "操作当前页面",
  platform_catalog: "发现平台操作",
  platform_read: "查询与预览资源",
  platform_skill: "加载内置 Skill",
  platform_propose: "准备资源变更",
  platform_navigate: "定位系统页面",
};
const summaries: Record<string, string> = {
  platform_app: "框架无关的应用协作：发现动作、读取状态、执行结构化动作并核对真实回执。",
  platform_ui: "开启页面协作后导航、搜索、切换视图和填写草稿；按当前用户权限执行并等待界面回执。",
  platform_catalog: "了解平台支持哪些操作，按当前权限找到完成任务所需的能力。",
  platform_read: "查询项目资源、阅读配置和资料，也能检查变更是否已经应用。",
  platform_skill: "按任务读取平台使用、智能体构建、流程编排、知识整理与权限协作指导。",
  platform_propose: "把创建、修改或发布整理成可审阅的变更清单，等你确认后应用。",
  platform_navigate: "找到相关页面并提供直达入口，点击后打开并定位资源。",
};
export function describeOperation(operation: Operation, available: Operation[]) {
  const allowed = available.some((o) => o.id === operation.id);
  return {
    id: operation.id,
    label: operation.label,
    group: operation.group,
    mode: operation.mode,
    risk: operation.risk,
    permission: operation.permission,
    tenantAdmin: !!operation.tenantAdmin,
    available: allowed,
    unavailableReason: allowed
      ? null
      : `需要 ${operation.permission}${operation.tenantAdmin ? " 与团队管理员身份" : ""}`,
  };
}
export function describeOperationDetail(id: string, registry: Operation[], available: Operation[]) {
  const operation = registry.find((o) => o.id === id);
  if (!operation) throw notFound();
  return AssistantOperationDetail.parse({
    ...describeOperation(operation, available),
    inputSchema: z.toJSONSchema(operation.schema, { unrepresentable: "any" }),
  });
}

/** Only the owning session may reach this projection; never return raw arguments or outputs. */
export async function describeCapabilities(
  db: Database,
  registry: Operation[],
  available: Operation[],
  permissions: string[],
  conversationId?: string,
) {
  const usage = conversationId
    ? await db.query(
        `
    SELECT tool_name,skill_id,count(*)::int AS count,max(created_at) AS last_used_at FROM (
      SELECT DISTINCT ON (i.run_id,i.chunk->>'toolCallId')
        i.chunk->>'toolName' AS tool_name,
        CASE WHEN i.chunk->>'toolName'='platform_skill' THEN o.chunk->'output'->'skill'->>'id' END AS skill_id,
        o.created_at
      FROM runs r JOIN run_events i ON i.run_id=r.id
      JOIN run_events o ON o.run_id=i.run_id AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId'
      WHERE r.conversation_id=$1 AND i.chunk->>'type'='tool-input-available'
        AND i.chunk->>'toolName' LIKE 'platform_%' AND o.chunk->>'type'='tool-output-available'
        AND o.chunk->'output'->>'isError' IS DISTINCT FROM 'true'
      ORDER BY i.run_id,i.chunk->>'toolCallId',o.seq DESC
    ) calls GROUP BY tool_name,skill_id`,
        [conversationId],
      )
    : [];
  const summary = (id: string, skill = false) => {
    const matches = usage.filter((r) => (skill ? r.skill_id : r.tool_name) === id);
    const dates = matches.map((r) => new Date(String(r.last_used_at)).toISOString()).sort();
    return {
      count: matches.reduce((n, r) => n + Number(r.count), 0),
      lastUsedAt: dates.at(-1) ?? null,
    };
  };
  return AssistantCapabilities.parse({
    version: 1,
    conversationId: conversationId ?? null,
    permissions,
    skills: assistantSkills.map((s) => ({
      ...s,
      version: 1,
      digest: sha256(s.instructions),
      source: "system",
      readOnly: true,
      bindable: false,
      usage: summary(s.id, true),
    })),
    tools: Object.entries(assistantToolDefinitions).map(([id, t]) => {
      const canUse = id !== "platform_propose" || available.some((o) => o.mode === "write");
      const inputSchema = z.toJSONSchema(t.inputSchema, { unrepresentable: "any" });
      return {
        id,
        name: names[id],
        description: t.description,
        summary: summaries[id],
        version: 1,
        digest: sha256(JSON.stringify({ description: t.description, inputSchema })),
        source: "system",
        readOnly: true,
        bindable: false,
        inputSchema,
        available: canUse,
        unavailableReason: canUse ? null : "当前角色没有可提交的写入操作，可以继续查询与问答",
        usage: summary(id),
      };
    }),
    operations: registry.map((o) => describeOperation(o, available)),
  });
}
