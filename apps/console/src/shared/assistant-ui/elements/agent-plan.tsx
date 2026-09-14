// Adapted from assistant-ui (MIT); see ../UPSTREAM.md for the pinned source and changes.
"use client";
import { AlertCircleIcon, CheckIcon, CircleIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../utils";

type Item = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  detail?: string;
};
export const planStates: Record<Item["status"], string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻",
  cancelled: "已取消",
};
const icons = {
  pending: CircleIcon,
  in_progress: Loader2Icon,
  completed: CheckIcon,
  blocked: AlertCircleIcon,
  cancelled: XCircleIcon,
};
export function AgentPlan({
  items,
  title,
  revision,
  live = false,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  items: readonly Item[];
  title: string;
  revision?: number;
  live?: boolean;
}) {
  const completed = items.filter((item) => item.status === "completed").length;
  return (
    <div data-slot="agent-plan" className={cn("aui-agent-plan", className)} {...props}>
      <div className="aui-agent-plan-heading">
        <strong>{title}</strong>
        <span>
          {revision ? `v${revision} · ` : ""}
          {completed} / {items.length} 项完成
        </span>
      </div>
      <div
        className="aui-agent-plan-progress"
        role="progressbar"
        aria-label="计划完成项"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={completed}
      >
        <span style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%` }} />
      </div>
      <ol>
        {items.map((item) => {
          const Icon = icons[item.status];
          return (
            <li key={item.id} data-status={item.status}>
              <Icon
                aria-hidden
                className={cn(
                  "size-4 shrink-0",
                  live &&
                    item.status === "in_progress" &&
                    "animate-spin motion-reduce:animate-none",
                )}
              />
              <div>
                <span>{item.title}</span>
                {item.detail && <p>{item.detail}</p>}
              </div>
              <small>{planStates[item.status]}</small>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
