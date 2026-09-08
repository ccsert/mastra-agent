import { Tag } from "antd";

const statusNames: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  pending: "待执行",
  skipped: "已跳过",
};
export function Status({ value }: { value: string }) {
  return (
    <Tag
      color={
        value === "succeeded"
          ? "success"
          : value === "failed"
            ? "error"
            : value === "running"
              ? "processing"
              : "default"
      }
    >
      {statusNames[value] ?? value}
    </Tag>
  );
}
