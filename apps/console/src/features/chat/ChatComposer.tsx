import { ArrowUpOutlined, BorderOutlined, FileZipOutlined } from "@ant-design/icons";
import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { ConversationCapabilities } from "@platform/sdk";
import { Button, Tag } from "antd";
import { useId, useState } from "react";
import { type ChatCommand, chatCommands } from "./commands";

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
  const aui = useAui(),
    listId = useId();
  const text = useAuiState((s) => s.composer.text),
    running = useAuiState((s) => s.thread.isRunning);
  const [opened, setOpened] = useState(false),
    [dismissed, setDismissed] = useState<string | null>(null),
    [active, setActive] = useState(0);
  const slash = text.startsWith("/") && !text.includes("\n");
  const open = !running && (opened || (slash && dismissed !== text));
  const options = chatCommands(slash ? text : "", skills).filter(
    (c) => !selected.includes(c.skillVersionId ?? ""),
  );
  const current = Math.min(active, Math.max(0, options.length - 1));
  function choose(command: ChatCommand) {
    if (command.disabled || !command.skillVersionId) return;
    onSelect([...selected, command.skillVersionId]);
    if (slash) aui.composer.setText("");
    setOpened(false);
    setActive(0);
    setDismissed(text);
  }
  return (
    <ComposerPrimitive.Root className="composer">
      {open && (
        <div className="chat-command-menu">
          <header>
            <strong>指定本次任务的 Skill</strong>
            <Button
              type="text"
              size="small"
              onClick={() => {
                setOpened(false);
                setDismissed(text);
              }}
            >
              关闭
            </Button>
          </header>
          <div id={listId} role="listbox" aria-label="聊天快捷指令">
            {options.map((command, i) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${i}`}
                key={command.id}
                aria-selected={current === i}
                aria-disabled={command.disabled}
                className={current === i ? "active" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(command)}
              >
                <FileZipOutlined />
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
              </button>
            ))}
            {!options.length && (
              <p>
                {loading
                  ? "正在加载会话能力…"
                  : error
                    ? "无法加载快捷指令，请刷新后重试。"
                    : skills.length
                      ? "没有匹配的可选 Skill。"
                      : "此会话版本尚未绑定 Skill。请在 Agent 中绑定并发布，再创建新会话。"}
              </p>
            )}
          </div>
          <footer>↑ ↓ 选择 · Enter 添加 · Esc 关闭 · 仅限会话已授权版本</footer>
        </div>
      )}
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
        aria-label="消息"
        placeholder="描述你的任务，输入 / 指定 Skill…"
        className="composer-input"
        rows={2}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-activedescendant={open && options.length ? `${listId}-${current}` : undefined}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key) && !e.shiftKey) {
            e.preventDefault();
            if (e.key === "Escape") {
              setOpened(false);
              setDismissed(text);
            }
            if (e.key === "ArrowDown") setActive((current + 1) % Math.max(1, options.length));
            if (e.key === "ArrowUp")
              setActive((current - 1 + options.length) % Math.max(1, options.length));
            if (e.key === "Enter" && options[current]) choose(options[current]);
          }
        }}
      />
      <div className="composer-footer">
        <Button
          type="text"
          size="small"
          icon={<FileZipOutlined />}
          disabled={running}
          onClick={() => {
            setOpened(!open);
            setDismissed(null);
          }}
        >
          快捷指令 /
        </Button>
        <span>Enter 发送 · Shift + Enter 换行</span>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            className="send-button"
            aria-label="发送消息"
            disabled={open && slash}
          >
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
  );
}
