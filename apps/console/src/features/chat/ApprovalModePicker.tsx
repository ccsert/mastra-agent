import {
  CheckOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import type { ApprovalPolicy } from "@platform/sdk";
import { getConversation, updateConversation } from "@platform/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Popover } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";

/** The composer's write-tool mode. The three presets map one-to-one onto the
 * runtime's gate: what runs without asking, what pauses for a person, and
 * what is refused outright. A change applies from the conversation's next
 * run; the current one keeps the mode it started with. */
const MODES: {
  value: ApprovalPolicy;
  label: string;
  icon: typeof EyeOutlined;
  description: string;
}[] = [
  {
    value: "readonly",
    label: "仅可查看",
    icon: EyeOutlined,
    description: "写入工具不会执行，也不会发起确认",
  },
  {
    value: "ask",
    label: "确认后修改",
    icon: SafetyOutlined,
    description: "每次写入先暂停，等你决定后才执行",
  },
  {
    value: "auto",
    label: "完全权限",
    icon: ExclamationCircleOutlined,
    description: "写入工具直接执行，不再逐次确认",
  },
];

export function ApprovalModePicker({
  projectId,
  conversationId,
  disabled,
}: {
  projectId: string;
  conversationId: string;
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const conversation = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "detail"),
    queryFn: ({ signal }) =>
      unwrap(getConversation({ path: { projectId, id: conversationId }, signal })),
    staleTime: 10_000,
    retry: false,
  });
  const current: ApprovalPolicy = conversation.data?.approvalPolicy ?? "ask";
  const change = useMutation({
    mutationFn: (policy: ApprovalPolicy) =>
      unwrap(
        updateConversation({
          path: { projectId, id: conversationId },
          body: { approvalPolicy: policy },
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: projectKey(projectId, "conversations", conversationId, "detail"),
      });
    },
  });
  const active = MODES.find((mode) => mode.value === current) ?? MODES[1];
  const ActiveIcon = active.icon;
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      open={open}
      onOpenChange={setOpen}
      content={
        <div className="approval-mode-menu" role="menu" aria-label="写入权限模式">
          {MODES.map((mode) => {
            const Icon = mode.icon;
            const selected = mode.value === current;
            return (
              <button
                key={mode.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`approval-mode-item${selected ? " is-active" : ""}`}
                disabled={change.isPending}
                onClick={() => {
                  change.mutate(mode.value);
                  setOpen(false);
                }}
              >
                <Icon aria-hidden="true" />
                <span className="approval-mode-text">
                  <strong>{mode.label}</strong>
                  <small>{mode.description}</small>
                </span>
                {selected && <CheckOutlined aria-hidden="true" className="approval-mode-check" />}
              </button>
            );
          })}
          <p className="approval-mode-note">运行中的任务沿用开始时的模式；切换对下一轮生效。</p>
        </div>
      }
    >
      <button
        type="button"
        className="approval-mode-trigger"
        aria-label={`写入权限模式：${active.label}`}
        aria-expanded={open}
        disabled={disabled || conversation.isPending}
      >
        <ActiveIcon aria-hidden="true" />
        <span>{active.label}</span>
      </button>
    </Popover>
  );
}
