import type { Run } from "@platform/sdk";
import { Tag } from "antd";

const statusNames: Record<Run["status"], string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};
const statusColors: Record<Run["status"], string> = {
  queued: "default",
  running: "processing",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
};
export function RunStatus({ status }: { status: Run["status"] }) {
  return <Tag color={statusColors[status]}>{statusNames[status]}</Tag>;
}
