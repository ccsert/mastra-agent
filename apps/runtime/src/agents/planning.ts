import { PlanUpdate, TaskPlan, traceEventNames } from "@platform/contracts";
import type { UIMessageChunk } from "ai";

/** Each execution scope owns an append-only, revisioned plan. Parallel updates are serialized. */
export function createPlanTracker(emit: (chunk: UIMessageChunk) => Promise<void>) {
  let current: TaskPlan | undefined;
  let delivery = Promise.resolve();
  return {
    update(input: PlanUpdate, toolCallId: string) {
      const result = delivery.then(async () => {
        const checked = PlanUpdate.parse(input);
        if (!toolCallId) throw new Error("PLAN_CALL_ID_REQUIRED");
        if (new Set(checked.items.map((item) => item.id)).size !== checked.items.length)
          throw new Error("PLAN_DUPLICATE_ITEM_ID");
        const revision = current?.revision ?? 0;
        if (checked.baseRevision !== revision)
          throw new Error(`PLAN_REVISION_CONFLICT: current revision is ${revision}`);
        const { baseRevision: _, ...content } = checked;
        const next = TaskPlan.parse({
          ...content,
          revision: revision + 1,
          toolCallId,
          updatedAt: new Date().toISOString(),
        });
        await emit({ type: traceEventNames.taskPlan, transient: true, data: next });
        current = next;
        return next;
      });
      delivery = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
