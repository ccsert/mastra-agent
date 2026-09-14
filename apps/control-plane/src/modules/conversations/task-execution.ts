import {
  ExecutionLimits,
  ReleaseSnapshot,
  type RuntimeTaskRequest,
  type z,
} from "@platform/contracts";
import type { Queryable, Row } from "@platform/database";
import { ApiError } from "../../infrastructure/errors.ts";
import { feedbackDto, readFeedback } from "./feedback.ts";

/** All calls run under the owning run's row lock and its current lease. */
export async function taskOperation(
  tx: Queryable,
  run: Row,
  input: z.infer<typeof RuntimeTaskRequest>,
) {
  const runId = run.id;
  switch (input.operation) {
    case "feedback":
      return { feedback: await readFeedback(tx, run.conversation_id) };
    case "feedback-read":
      await tx.query(
        "UPDATE task_feedback f SET read_at=coalesce(read_at,now()) FROM runs r WHERE f.run_id=r.id AND r.conversation_id=$1 AND f.id=ANY($2::uuid[])",
        [run.conversation_id, input.ids],
      );
      return { ok: true };
    case "history": {
      const previous = await tx.query(
        "SELECT id,status,error_code,input_text,output_text FROM runs WHERE conversation_id=$1 AND id<>$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 5",
        [run.conversation_id, runId, input.runId ?? null],
      );
      const runs = [];
      for (const row of previous) {
        const reviews = await tx.query(
          "SELECT DISTINCT ON (chunk->'data'->>'id') chunk->'data'->>'id' AS id,chunk->'data'->>'name' AS name,chunk->'data'->>'status' AS status,left(chunk->'data'->>'outputText',12000) AS output FROM run_events WHERE run_id=$1 AND chunk->>'type'='data-subagent' ORDER BY chunk->'data'->>'id',seq DESC",
          [row.id],
        );
        const artifacts = await tx.query(
          "SELECT 'file-'||id AS id,name,media_type AS \"mediaType\",sha256,octet_length(bytes) AS size FROM task_artifacts WHERE run_id=$1 ORDER BY created_at LIMIT 100",
          [row.id],
        );
        runs.push({
          runId: row.id,
          status: row.status,
          errorCode: row.error_code,
          input: String(row.input_text ?? "").slice(0, 2000),
          output: String(row.output_text ?? "").slice(0, 4000),
          reviews,
          artifacts,
          feedback: (
            await tx.query("SELECT * FROM task_feedback WHERE run_id=$1 ORDER BY position", [
              row.id,
            ])
          ).map(feedbackDto),
        });
      }
      return {
        runs,
        coverage:
          "最近 5 次执行的输入摘要、已保存回复、子代理结果与产物。原始逐步事件继续单独保存；没有记录的内容不补写。",
      };
    }
    case "artifact": {
      const bytes = Buffer.from(input.contentBase64, "base64");
      if (bytes.length > 5 * 1024 * 1024)
        throw new ApiError(400, "WORKSPACE_LIMIT", "单个产物超过 5 MiB");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const [existing] = await tx.query(
        "SELECT id FROM task_artifacts WHERE run_id=$1 AND name=$2 AND sha256=$3 AND media_type=$4 ORDER BY created_at LIMIT 1",
        [runId, input.name, hash, input.mediaType],
      );
      if (existing)
        return {
          id: `file-${existing.id}`,
          sha256: hash,
          name: input.name,
          mediaType: input.mediaType,
          size: bytes.length,
        };
      const [total] = await tx.query(
        "SELECT coalesce(sum(octet_length(bytes)),0) AS bytes,count(*) AS count FROM task_artifacts WHERE run_id=$1",
        [runId],
      );
      if (Number(total.bytes) + bytes.length > 50 * 1024 * 1024 || Number(total.count) >= 100)
        throw new ApiError(409, "WORKSPACE_LIMIT", "本轮产物达到容量上限");
      const id = randomUUID();
      await tx.query(
        "INSERT INTO task_artifacts(id,run_id,tool_call_id,name,media_type,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, runId, input.toolCallId, input.name, input.mediaType, hash, bytes],
      );
      return {
        id: `file-${id}`,
        sha256: hash,
        name: input.name,
        mediaType: input.mediaType,
        size: bytes.length,
      };
    }
    case "reserve": {
      const [release] = await tx.query("SELECT snapshot FROM releases WHERE id=$1", [
        run.release_id,
      ]);
      const limits = ExecutionLimits.parse(
        ReleaseSnapshot.parse(release.snapshot).agent.executionLimits ?? {},
      );
      const [existing] = await tx.query(
        "SELECT estimated_tokens FROM run_model_reservations WHERE run_id=$1 AND request_id=$2",
        [runId, input.requestId],
      );
      if (existing) {
        if (Number(existing.estimated_tokens) !== input.estimatedTokens)
          throw new ApiError(409, "EVENT_CONFLICT", "模型预算请求不一致");
        return { ok: true };
      }
      const [usage] = await tx.query(
        "SELECT count(*) AS calls,coalesce(sum(coalesce(actual_tokens,estimated_tokens)),0) AS tokens FROM run_model_reservations WHERE run_id=$1",
        [runId],
      );
      if (Number(usage.calls) >= limits.maxModelCalls)
        throw new ApiError(409, "MODEL_CALL_LIMIT", "已达到总模型调用上限");
      if (Number(usage.tokens) + input.estimatedTokens > limits.maxTokens)
        throw new ApiError(409, "TOKEN_BUDGET", "已达到 Token 预留预算");
      await tx.query(
        "INSERT INTO run_model_reservations(run_id,request_id,estimated_tokens) VALUES($1,$2,$3)",
        [runId, input.requestId, input.estimatedTokens],
      );
      return { ok: true };
    }
    case "settle": {
      const [row] = await tx.query(
        "SELECT actual_tokens FROM run_model_reservations WHERE run_id=$1 AND request_id=$2",
        [runId, input.requestId],
      );
      if (!row || (row.actual_tokens !== null && Number(row.actual_tokens) !== input.actualTokens))
        throw new ApiError(409, "EVENT_CONFLICT", "模型用量结算请求不一致");
      await tx.query(
        "UPDATE run_model_reservations SET actual_tokens=$1 WHERE run_id=$2 AND request_id=$3",
        [input.actualTokens, runId, input.requestId],
      );
      return { ok: true };
    }
    case "load": {
      const [row] = await tx.query(
        "SELECT data FROM agent_workflow_snapshots WHERE run_id=$1 AND workflow_name=$2",
        [runId, input.workflowName],
      );
      return { snapshot: row?.data ?? null };
    }
    case "save": {
      if (input.snapshot.runId !== runId)
        throw new ApiError(400, "INVALID_SNAPSHOT", "快照不属于本次执行");
      if (Buffer.byteLength(JSON.stringify(input.snapshot)) > 16 * 1024 * 1024)
        throw new ApiError(400, "WORKSPACE_LIMIT", "执行快照超过容量");
      await tx.query(
        "INSERT INTO agent_workflow_snapshots(run_id,workflow_name,data) VALUES($1,$2,$3) ON CONFLICT(run_id,workflow_name) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",
        [runId, input.workflowName, input.snapshot],
      );
      return { ok: true };
    }
    case "list": {
      const rows = await tx.query("SELECT * FROM agent_workflow_snapshots WHERE run_id=$1", [
        runId,
      ]);
      return {
        runs: rows.map((row) => ({
          runId,
          workflowName: row.workflow_name,
          snapshot: row.data,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        total: rows.length,
      };
    }
    case "delete":
      await tx.query("DELETE FROM agent_workflow_snapshots WHERE run_id=$1 AND workflow_name=$2", [
        runId,
        input.workflowName,
      ]);
      return { ok: true };
    case "tool-start": {
      const [receipt] = await tx.query(
        "SELECT * FROM run_tool_receipts WHERE run_id=$1 AND call_id=$2",
        [runId, input.callId],
      );
      if (receipt) {
        if (receipt.input_hash !== input.inputHash || receipt.status === "running")
          throw new ApiError(
            409,
            "TOOL_OUTCOME_UNKNOWN",
            "上次工具调用的结果无法确认，已停止自动重试",
          );
        return { cached: true, output: receipt.output, errorCode: receipt.error_code };
      }
      await tx.query(
        "INSERT INTO run_tool_receipts(run_id,call_id,input_hash,status) VALUES($1,$2,$3,'running')",
        [runId, input.callId, input.inputHash],
      );
      return { cached: false };
    }
    case "tool-finish":
      await tx.query(
        "UPDATE run_tool_receipts SET status=$1,output=$2::jsonb,error_code=$3 WHERE run_id=$4 AND call_id=$5 AND status='running'",
        [
          input.errorCode ? "failed" : "succeeded",
          JSON.stringify(input.output ?? null),
          input.errorCode ?? null,
          runId,
          input.callId,
        ],
      );
      return { ok: true };
    case "state": {
      if (input.state.status === "completed" && !input.state.evidence.length)
        throw new ApiError(400, "ACCEPTANCE_EVIDENCE_REQUIRED", "任务完成必须记录验收证据");
      const [current] = await tx.query(
        "SELECT revision,run_id,data,(data-'revision'-'runId')=$2::jsonb AS same FROM conversation_task_state WHERE conversation_id=$1",
        [run.conversation_id, JSON.stringify(input.state)],
      );
      const revision = Number(current?.revision ?? 0);
      if (revision === input.state.baseRevision + 1 && current?.run_id === runId && current.same)
        return current.data;
      if (revision !== input.state.baseRevision)
        throw new ApiError(409, "REVISION_CONFLICT", "任务进度已变化，请读取最新进度");
      const value = { ...input.state, revision: revision + 1, runId };
      await tx.query(
        "INSERT INTO conversation_task_state(conversation_id,revision,run_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id) DO UPDATE SET revision=EXCLUDED.revision,run_id=EXCLUDED.run_id,data=EXCLUDED.data,updated_at=now()",
        [run.conversation_id, value.revision, runId, value],
      );
      return value;
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
