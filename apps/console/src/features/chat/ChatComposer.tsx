import { ArrowUpOutlined, BorderOutlined, FileZipOutlined } from "@ant-design/icons";
import {
  AuiIf,
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { ConversationCapabilities } from "@platform/sdk";
import { Button, Tag } from "antd";
import { useRef } from "react";
import { ComposerTriggerPopover } from "../../shared/assistant-ui";
import { skillCommands, skillTriggerMatcher } from "./commands";

export function ChatComposer({
  skills,
  selected,
  onSelect,
  stop,
  loading,
  error,
}: {
  skills: ConversationCapabilities["skills"];
  selected: string[];
  onSelect(ids: string[]): void;
  stop(): Promise<void>;
  loading: boolean;
  error: boolean;
}) {
  const aui = useAui();
  const input = useRef<HTMLTextAreaElement>(null);
  const running = useAuiState((s) => s.thread.isRunning);
  const slash = unstable_useSlashCommandAdapter({
    commands: running ? [] : skillCommands(skills, selected, onSelect),
    removeOnExecute: true,
    fallbackIcon: FileZipOutlined,
  });
  const emptyLabel = error
    ? "无法加载快捷指令，请刷新后重试。"
    : selected.length >= 10
      ? "一次任务最多指定 10 个 Skill。"
      : skills.some((s) => s.enabled)
        ? "没有匹配的可选 Skill；已选择或已停用版本不会重复列出。"
        : "此会话没有可用 Skill。请绑定并发布 Agent，再创建新会话。";
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="composer assistant-elements">
        <ComposerTriggerPopover
          char="/"
          {...slash}
          matcher={skillTriggerMatcher}
          isLoading={loading}
          aria-label="聊天快捷指令"
          backLabel="返回"
          emptyItemsLabel={emptyLabel}
          emptyCategoriesLabel={emptyLabel}
          loadingLabel="正在加载会话能力…"
        />
        {!!selected.length && (
          <section className="chat-command-selection" aria-label="本次指定的 Skills">
            {selected.map((id) => {
              const skill = skills.find((s) => s.versionId === id);
              return (
                <Tag
                  key={id}
                  closable={!running}
                  onClose={() => onSelect(selected.filter((s) => s !== id))}
                  icon={<FileZipOutlined />}
                >
                  {skill?.name ?? id} · v{skill?.version}
                </Tag>
              );
            })}
          </section>
        )}
        <ComposerPrimitive.Input
          ref={input}
          aria-label="消息"
          placeholder="描述你的任务，输入 / 指定 Skill…"
          className="composer-input"
          rows={2}
        />
        <div className="composer-footer">
          <Button
            type="text"
            size="small"
            icon={<FileZipOutlined />}
            disabled={running}
            onClick={() => {
              const text = aui.composer.getState().text;
              aui.composer.setText(text ? `${text}\n/` : "/");
              input.current?.focus();
            }}
          >
            快捷指令 /
          </Button>
          <span>Enter 发送 · Shift + Enter 换行</span>
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <ComposerPrimitive.Send className="send-button" aria-label="发送消息">
              <ArrowUpOutlined />
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning}>
            <button
              type="button"
              className="send-button cancel-button"
              aria-label="停止生成"
              onClick={() => void stop()}
            >
              <BorderOutlined />
            </button>
          </AuiIf>
        </div>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
