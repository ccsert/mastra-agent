import {
  agentWorkflowInput,
  agentWorkflowOutput,
  type Release,
  type Tool,
  WorkflowCapability,
  type WorkflowDefinition,
  type z,
} from "@platform/contracts";
import type { Queryable } from "@platform/database";
import { ApiError } from "../../infrastructure/errors.ts";
import { toolDto } from "../resources/index.ts";

export function toolCapability(tool: z.infer<typeof Tool>): WorkflowCapability {
  const outputSchema =
    tool.kind === "mcp" && tool.mcp?.descriptor.outputSchema
      ? {
          type: "object",
          properties: { text: { type: "string" }, data: tool.mcp.descriptor.outputSchema },
          required: ["text", "data"],
          additionalProperties: false,
        }
      : tool.outputSchema;
  return {
    kind: "tool",
    id: tool.id,
    name: tool.name,
    description: tool.description,
    version: tool.version,
    inputSchema: tool.inputSchema,
    outputSchema,
  };
}
export const agentCapability = (release: z.infer<typeof Release>): WorkflowCapability => ({
  kind: "agent",
  id: release.id,
  name: release.snapshot.agent.name,
  description: release.snapshot.agent.description,
  version: release.version,
  inputSchema: agentWorkflowInput,
  outputSchema: agentWorkflowOutput,
});

/** Narrow this generation only; preserve the capabilities already referenced by its saved draft. */
export function generationCatalog(
  entries: WorkflowCapability[],
  definition: WorkflowDefinition,
  selected?: string[],
) {
  const ids = new Set(selected ?? entries.map((entry) => entry.id));
  for (const node of definition.nodes) {
    if (node.type === "tool") ids.add(node.toolId);
    if (node.type === "agent") ids.add(node.releaseId);
  }
  const available = new Set(entries.map((entry) => entry.id));
  if ([...ids].some((id) => !available.has(id)))
    throw new ApiError(
      409,
      "DEPENDENCY_UNAVAILABLE",
      "本次选择或流程已引用的能力不可用，请检查版本及访问状态",
    );
  const catalog = entries.filter((entry) => ids.has(entry.id));
  if (JSON.stringify(catalog).length > 160000)
    throw new ApiError(
      400,
      "CATALOG_LIMIT",
      "本次能力目录超过编排上下文限制，请在可用能力中缩小范围",
    );
  return catalog;
}

/**
 * A catalog describes published capabilities, not mutable Agent drafts. Publishing has already
 * validated their definitions. Check live access against the pinned dependencies in SQL, without
 * per-release validation queries or fetching credential ciphertext / complete release snapshots.
 * Publication and execution still validate dependencies independently; this read grants no access.
 */
export async function loadWorkflowCatalog(
  db: Queryable,
  scope: { projectId: string; tenantId: string },
): Promise<WorkflowCapability[]> {
  const params = [scope.projectId, scope.tenantId];
  const tools = await db.query(
    `SELECT t.id,t.project_id,t.data,t.created_at FROM resources t
     WHERE t.project_id=$1 AND t.tenant_id=$2 AND t.kind='tool'
       AND (t.data->>'kind'<>'mcp' OR EXISTS (
         SELECT 1 FROM mcp_imports i JOIN mcp_servers s ON s.id=i.server_id
         WHERE i.tool_id=t.id AND i.contract_digest=t.data->'mcp'->>'contractDigest'
           AND s.project_id=$1 AND s.tenant_id=$2 AND s.enabled
       ))
     ORDER BY t.created_at DESC,t.id DESC`,
    params,
  );
  const releases = await db.query(
    `SELECT r.id,r.version,r.snapshot->'agent'->>'name' AS name,
       r.snapshot->'agent'->>'description' AS description
     FROM releases r
     WHERE r.project_id=$1 AND r.tenant_id=$2
       AND EXISTS (
         SELECT 1 FROM resources m WHERE m.id=(r.snapshot->'model'->>'id')::uuid
           AND m.project_id=$1 AND m.tenant_id=$2 AND m.kind='model'
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.snapshot->'tools') dep
         WHERE NOT EXISTS (
           SELECT 1 FROM resources t WHERE t.id=(dep->>'id')::uuid
             AND t.project_id=$1 AND t.tenant_id=$2 AND t.kind='tool'
         ) OR (dep->>'kind'='mcp' AND NOT EXISTS (
           SELECT 1 FROM mcp_imports i JOIN mcp_servers s ON s.id=i.server_id
           WHERE i.tool_id=(dep->>'id')::uuid
             AND i.contract_digest=dep->'mcp'->>'contractDigest'
             AND s.project_id=$1 AND s.tenant_id=$2 AND s.enabled
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.snapshot->'knowledgeBases') dep
         WHERE NOT EXISTS (
           SELECT 1 FROM knowledge_bases k WHERE k.id=(dep->>'id')::uuid
             AND k.project_id=$1 AND k.tenant_id=$2
         ) OR NOT EXISTS (
           SELECT 1 FROM resources m WHERE m.id=(dep->'embeddingModel'->>'id')::uuid
             AND m.project_id=$1 AND m.tenant_id=$2 AND m.kind='model'
         ) OR (dep->'rerankModel' IS NOT NULL AND dep->'rerankModel'<>'null'::jsonb
           AND NOT EXISTS (
             SELECT 1 FROM resources m WHERE m.id=(dep->'rerankModel'->>'id')::uuid
               AND m.project_id=$1 AND m.tenant_id=$2 AND m.kind='model'
           ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.snapshot->'skills') dep
         WHERE NOT EXISTS (
           SELECT 1 FROM skill_versions s WHERE s.id=(dep->>'id')::uuid
             AND s.project_id=$1 AND s.tenant_id=$2 AND s.enabled
             AND s.digest=dep->>'digest'
         )
       )
     ORDER BY r.created_at DESC,r.id DESC`,
    params,
  );
  return [
    ...tools.map((row) => toolCapability(toolDto(row))),
    ...releases.map((row) =>
      WorkflowCapability.parse({
        ...row,
        kind: "agent",
        inputSchema: agentWorkflowInput,
        outputSchema: agentWorkflowOutput,
      }),
    ),
  ];
}
