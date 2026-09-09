import type { ReleaseSnapshot } from "@platform/contracts";
import type { Queryable } from "@platform/database";
import type { Vault } from "../../infrastructure/crypto.ts";
import { ApiError } from "../../infrastructure/errors.ts";

interface CredentialScope {
  tenantId: string;
  projectId: string;
}
export async function resourceCredential(
  tx: Queryable,
  vault: Vault,
  scope: CredentialScope,
  id: string,
  kind: "tool" | "model",
) {
  const [resource] = await tx.query(
    "SELECT secret_enc FROM resources WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND kind=$4",
    [id, scope.tenantId, scope.projectId, kind],
  );
  if (!resource) throw new ApiError(409, "DEPENDENCY_UNAVAILABLE", "固定发布依赖不可用");
  return vault.decrypt(String(resource.secret_enc));
}
export async function executionCredentials(
  tx: Queryable,
  vault: Vault,
  scope: CredentialScope,
  snapshot: ReleaseSnapshot,
) {
  const secret = (id: string, kind: "tool" | "model") =>
    resourceCredential(tx, vault, scope, id, kind);
  const modelApiKey = await secret(snapshot.model.id, "model"),
    toolTokens: Record<string, string> = {},
    knowledgeModelKeys: Record<string, string> = {};
  for (const tool of snapshot.tools)
    if (tool.kind !== "mcp") toolTokens[tool.id] = await secret(tool.id, "tool");
  for (const kb of snapshot.knowledgeBases)
    for (const model of [kb.embeddingModel, kb.rerankModel])
      if (model) knowledgeModelKeys[model.id] = await secret(model.id, "model");
  return { modelApiKey, toolTokens, knowledgeModelKeys };
}
