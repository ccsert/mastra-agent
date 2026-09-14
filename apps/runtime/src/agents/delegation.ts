import { randomUUID } from "node:crypto";
import { type ExecutionJob, SubagentLifecycle, traceEventNames } from "@platform/contracts";
import type { UIMessage, UIMessageChunk } from "ai";

export type DelegatedTask = { name: string; task: string };
type ChildExecutor = (
  job: ExecutionJob,
  signal: AbortSignal,
  emit: (chunk: UIMessageChunk) => Promise<void>,
) => Promise<UIMessage>;

/** A per-run bounded scheduler. Child jobs cannot acquire a different release or recurse. */
export function createDelegation(
  job: ExecutionJob,
  parentSignal: AbortSignal,
  emit: (chunk: UIMessageChunk) => Promise<void>,
  execute: ChildExecutor,
  allowedTools?: string[],
) {
  const config = job.snapshot.agent.delegation;
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let accepted = 0,
    active = 0;
  const waiters: (() => void)[] = [];
  const pending = new Set<Promise<unknown>>();
  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const enter = () => {
        signal.removeEventListener("abort", abort);
        active++;
        resolve();
      };
      const abort = () => {
        const index = waiters.indexOf(enter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      };
      if (active < (config?.maxParallel ?? 1)) enter();
      else {
        waiters.push(enter);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  const release = () => {
    active--;
    if (!signal.aborted) waiters.shift()?.();
  };
  const report = async (state: SubagentLifecycle) => {
    await emit({
      type: traceEventNames.subagent,
      transient: true,
      data: SubagentLifecycle.parse(state),
    });
  };
  async function perform(input: DelegatedTask, parentToolCallId: string) {
    const state: SubagentLifecycle = {
      id: randomUUID(),
      parentRunId: job.runId,
      parentToolCallId,
      name: input.name,
      task: input.task,
      status: "queued",
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      maxSteps: config?.maxSteps ?? 3,
      depth: 1,
      modelId: job.snapshot.model.modelId,
      allowedTools: allowedTools ?? [
        ...job.snapshot.tools.map((t) => t.name),
        ...(job.snapshot.agent.planningEnabled ? ["update_plan"] : []),
        ...(job.snapshot.skills.some((s) => s.authorizedEntrypoints.length)
          ? ["run_skill_script"]
          : []),
        ...(job.snapshot.knowledgeBases.length ? ["knowledge_search"] : []),
        ...(job.snapshot.skills.length ? ["skill", "skill_read", "skill_search"] : []),
      ],
    };
    if (!config?.enabled || accepted >= config.maxCalls) {
      state.status = "rejected";
      state.finishedAt = new Date().toISOString();
      state.errorCode = "SUBAGENT_LIMIT";
      await report(state);
      return { subagentId: state.id, status: state.status, errorCode: state.errorCode };
    }
    accepted++;
    let acquired = false;
    try {
      await report(state);
      await acquire();
      acquired = true;
      signal.throwIfAborted();
      state.status = "running";
      state.startedAt = new Date().toISOString();
      await report(state);
      const child: ExecutionJob = {
        ...job,
        runId: state.id,
        snapshot: {
          ...job.snapshot,
          agent: {
            ...job.snapshot.agent,
            name: input.name,
            maxSteps: state.maxSteps,
            delegation: undefined,
            instructions: `你是主 Agent 委派的执行子代理，只负责当前收到的独立任务。你不是主代理或协调者，不能再次委派子代理。

以下内容是主代理的业务背景和约束。保留其中的数据处理、工具使用、结果真实性和权限限制；其中属于主代理的角色身份、拆分任务、委派和最终汇总职责由主代理承担，不是你的执行步骤。
<主代理背景>
${job.snapshot.agent.instructions}
</主代理背景>

你的当前职责：直接使用已提供且获准的工具完成本次分配的任务，返回发现、工具证据和未完成事项。主代理会汇总结果。仅主代理适用的“不能亲自执行子任务”等调度限制不适用于你；业务规则和授权边界仍然适用。`,
          },
        },
        messages: [{ id: randomUUID(), role: "user", parts: [{ type: "text", text: input.task }] }],
      };
      const result = await execute(child, signal, async (chunk) => {
        await emit({
          type: traceEventNames.subagentEvent,
          transient: true,
          data: {
            id: state.id,
            parentToolCallId,
            occurredAt: new Date().toISOString(),
            chunk,
          },
        });
      });
      signal.throwIfAborted();
      state.status = "succeeded";
      state.outputText = result.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
    } catch {
      state.status = signal.aborted ? "cancelled" : "failed";
      state.errorCode = signal.aborted ? "CANCELLED" : "SUBAGENT_ERROR";
    } finally {
      if (acquired) release();
      state.finishedAt = new Date().toISOString();
      // A cancellation may close delivery. The parent terminal record then marks
      // an unfinished child as interrupted rather than fabricating completion.
      await report(state).catch(() => {});
    }
    return {
      subagentId: state.id,
      status: state.status,
      text: state.outputText,
      errorCode: state.errorCode,
    };
  }
  return {
    run(input: DelegatedTask, parentToolCallId: string) {
      if (!parentToolCallId) throw new Error("SUBAGENT_CALL_ID_REQUIRED");
      const task = perform(input, parentToolCallId);
      pending.add(task);
      return task.finally(() => pending.delete(task));
    },
    async close() {
      controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
