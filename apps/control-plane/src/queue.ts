import { randomUUID } from "node:crypto";
import type { z } from "@platform/contracts";
import {
  ExecutionJob,
  Message,
  ReleaseSnapshot,
  type RuntimeFinishInput,
} from "@platform/contracts";
import type { Database, Row } from "@platform/database";
import { uiMessageChunkSchema, validateUIMessages } from "ai";
import type { Vault } from "./crypto.ts";
import { ApiError } from "./errors.ts";
export class Queue {
  constructor(
    readonly db: Database,
    readonly vault: Vault,
    readonly runtimeId: string,
  ) {}
  async heartbeat() {
    await this.db.query("UPDATE runtimes SET last_seen_at=now() WHERE id=$1", [this.runtimeId]);
  }
  async reap() {
    await this.db.query(
      "UPDATE runs SET status='failed',error_code=CASE WHEN status='queued' THEN 'RUNTIME_UNAVAILABLE' ELSE 'RUNTIME_LOST' END,finished_at=now() WHERE (status='queued' AND deadline<now()) OR (status='running' AND (lease_until<now() OR deadline<now()))",
    );
    await this.db.query("DELETE FROM auth_nonces WHERE expires_at<now()");
    await this.db.query("DELETE FROM sessions WHERE expires_at<now()");
  }
  async claim(): Promise<ExecutionJob | null> {
    await this.heartbeat();
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query(
        "SELECT * FROM runs WHERE runtime_id=$1 AND status='queued' AND deadline>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [this.runtimeId],
      );
      if (!run) return null;
      const leaseToken = randomUUID();
      await tx.query(
        "UPDATE runs SET status='running',lease_token=$1,lease_until=now()+interval '20 seconds' WHERE id=$2",
        [leaseToken, run.id],
      );
      const [release] = await tx.query(
        "SELECT snapshot FROM releases WHERE id=$1 AND project_id=$2",
        [run.release_id, run.project_id],
      );
      const snapshot = ReleaseSnapshot.parse(release.snapshot),
        toolTokens: Record<string, string> = {};
      const secret = async (id: string, kind: string) => {
        const [r] = await tx.query(
          "SELECT secret_enc FROM resources WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND kind=$4",
          [id, run.tenant_id, run.project_id, kind],
        );
        if (!r) throw new ApiError(409, "DEPENDENCY_UNAVAILABLE", "固定发布依赖不可用");
        return this.vault.decrypt(String(r.secret_enc));
      };
      const modelApiKey = await secret(snapshot.model.id, "model");
      for (const tool of snapshot.tools) toolTokens[tool.id] = await secret(tool.id, "tool");
      const messages = (
        await tx.query("SELECT data FROM messages WHERE conversation_id=$1 ORDER BY position", [
          run.conversation_id,
        ])
      ).map((r) => Message.parse(r.data));
      return ExecutionJob.parse({
        runId: run.id,
        leaseToken,
        snapshot,
        messages,
        credentials: { modelApiKey, toolTokens },
        deadline: new Date(String(run.deadline)).getTime(),
      });
    });
  }
  private active(run: Row | undefined, leaseToken: string) {
    if (
      run?.status !== "running" ||
      run.lease_token !== leaseToken ||
      new Date(String(run.lease_until)).getTime() < Date.now() ||
      new Date(String(run.deadline)).getTime() < Date.now()
    )
      throw new ApiError(409, "LEASE_EXPIRED", "运行租约已失效");
  }
  async renew(id: string, leaseToken: string) {
    const [r] = await this.db.query(
      "UPDATE runs SET lease_until=now()+interval '20 seconds' WHERE id=$1 AND lease_token=$2 AND runtime_id=$3 AND status='running' AND lease_until>now() AND deadline>now() RETURNING cancel_requested",
      [id, leaseToken, this.runtimeId],
    );
    if (!r) throw new ApiError(409, "LEASE_EXPIRED", "运行租约已失效");
    await this.heartbeat();
    return { cancelRequested: Boolean(r.cancel_requested) };
  }
  async append(id: string, leaseToken: string, seq: number, chunk: Record<string, unknown>) {
    const checked = await uiMessageChunkSchema().validate?.(chunk);
    if (!checked?.success) throw new ApiError(400, "INVALID_EVENT", "事件不符合消息流协议");
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query("SELECT * FROM runs WHERE id=$1 AND runtime_id=$2 FOR UPDATE", [
        id,
        this.runtimeId,
      ]);
      this.active(run, leaseToken);
      const [existing] = await tx.query(
        "SELECT chunk=$3::jsonb AS same FROM run_events WHERE run_id=$1 AND seq=$2",
        [id, seq, chunk],
      );
      if (existing) {
        if (!existing.same) throw new ApiError(409, "EVENT_CONFLICT", "重复序号的内容不一致");
        return;
      }
      const [last] = await tx.query("SELECT max(seq) AS seq FROM run_events WHERE run_id=$1", [id]);
      if (seq !== Number(last.seq ?? -1) + 1 || seq > 10000)
        throw new ApiError(409, "EVENT_SEQUENCE", "事件序号不连续或超过预算");
      await tx.query("INSERT INTO run_events(run_id,seq,chunk) VALUES($1,$2,$3)", [id, seq, chunk]);
    });
  }
  async finish(id: string, input: z.infer<typeof RuntimeFinishInput>) {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.query("SELECT * FROM runs WHERE id=$1 AND runtime_id=$2 FOR UPDATE", [
        id,
        this.runtimeId,
      ]);
      this.active(run, input.leaseToken);
      const status = run.cancel_requested ? "cancelled" : input.status;
      let outputText: string | null = null;
      if (status === "succeeded") {
        if (input.message?.role !== "assistant")
          throw new ApiError(400, "INVALID_COMPLETION", "缺少完整的 Assistant 消息");
        try {
          await validateUIMessages({ messages: [input.message] });
        } catch {
          throw new ApiError(400, "INVALID_COMPLETION", "Assistant 消息格式不正确");
        }
        const message = { ...input.message, id: `assistant-${id}` };
        outputText = message.parts
          .filter((p) => p.type === "text")
          .map((p) => String(p.text ?? ""))
          .join("");
        await tx.query("INSERT INTO messages(id,conversation_id,data) VALUES($1,$2,$3)", [
          message.id,
          run.conversation_id,
          message,
        ]);
      }
      await tx.query(
        "UPDATE runs SET status=$1,finished_at=now(),error_code=$2,output_text=$3 WHERE id=$4",
        [status, status === "succeeded" ? null : (input.errorCode ?? "CANCELLED"), outputText, id],
      );
    });
  }
}
