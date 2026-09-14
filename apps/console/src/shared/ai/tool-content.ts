import type { TaskPlan } from "@platform/sdk";
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function readPlan(value: unknown): TaskPlan | undefined {
  const plan = asRecord(value);
  if (
    typeof plan.title !== "string" ||
    typeof plan.explanation !== "string" ||
    !Number.isInteger(plan.revision) ||
    Number(plan.revision) < 1 ||
    Number(plan.revision) > 100 ||
    typeof plan.toolCallId !== "string" ||
    typeof plan.updatedAt !== "string" ||
    !Array.isArray(plan.items) ||
    !plan.items.length ||
    plan.items.length > 20
  )
    return;
  if (
    !plan.items.every((raw) => {
      const item = asRecord(raw);
      return (
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        ["pending", "in_progress", "completed", "blocked", "cancelled"].includes(
          String(item.status),
        ) &&
        (item.detail === undefined || typeof item.detail === "string")
      );
    }) ||
    new Set(plan.items.map((i) => i.id)).size !== plan.items.length
  )
    return;
  return plan as TaskPlan;
}
export function planChanges(current: TaskPlan, previous?: TaskPlan) {
  const statuses = {
    pending: "待处理",
    in_progress: "进行中",
    completed: "已完成",
    blocked: "受阻",
    cancelled: "已取消",
  };
  if (!previous)
    return current.items.map((item) => ({ id: item.id, title: item.title, change: "新增" }));
  const before = new Map(previous.items.map((item) => [item.id, item]));
  const after = new Set(current.items.map((item) => item.id));
  return [
    ...current.items.flatMap((item) => {
      const old = before.get(item.id);
      return !old
        ? [{ id: item.id, title: item.title, change: "新增" }]
        : old.title !== item.title || old.status !== item.status || old.detail !== item.detail
          ? [
              {
                id: item.id,
                title: item.title,
                change:
                  old.status !== item.status
                    ? `${statuses[old.status]} → ${statuses[item.status]}`
                    : "内容变更",
              },
            ]
          : [];
    }),
    ...previous.items
      .filter((item) => !after.has(item.id))
      .map((item) => ({ id: item.id, title: item.title, change: "从本版移除" })),
  ];
}
