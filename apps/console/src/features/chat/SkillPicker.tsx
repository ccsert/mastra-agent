import { CheckOutlined, FileZipOutlined, SearchOutlined } from "@ant-design/icons";
import type { ConversationCapabilities } from "@platform/sdk";
import { Button, type GetRef, Input, Popover, Spin } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  skills: ConversationCapabilities["skills"];
  selected: string[];
  onSelect(ids: string[]): void;
  disabled: boolean;
  loading: boolean;
  error: boolean;
  onRetry(): void;
};
export function SkillPicker({
  skills,
  selected,
  onSelect,
  disabled,
  loading,
  error,
  onRetry,
}: Props) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const trigger = useRef<GetRef<typeof Button>>(null),
    searchInput = useRef<GetRef<typeof Input>>(null);
  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);
  const query = search.trim().toLowerCase();
  const items = skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query));
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      open={open && !disabled}
      afterOpenChange={(visible) => {
        if (visible) searchInput.current?.focus();
      }}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSearch("");
      }}
      content={
        <section className="chat-skill-picker" role="dialog" aria-label="选择 Skills">
          <header>
            <div>
              <strong>本次使用的 Skills</strong>
              <p>只影响下一条消息，可多选</p>
            </div>
            <span>{selected.length} / 10</span>
          </header>
          <Input
            ref={searchInput}
            aria-label="搜索 Skills"
            placeholder="搜索名称或用途"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
          <div className="chat-skill-options" aria-busy={loading}>
            {loading ? (
              <div className="chat-skill-empty">
                <Spin size="small" /> 正在加载 Skills…
              </div>
            ) : error ? (
              <div className="chat-skill-empty" role="status">
                无法加载会话的 Skills。
                <Button type="link" onClick={onRetry}>
                  重新加载
                </Button>
              </div>
            ) : items.length ? (
              items.map((skill) => {
                const checked = selected.includes(skill.versionId),
                  unavailable = !checked && (!skill.enabled || selected.length >= 10);
                return (
                  <button
                    key={skill.versionId}
                    type="button"
                    className="chat-skill-option"
                    aria-pressed={checked}
                    disabled={unavailable}
                    onClick={() =>
                      onSelect(
                        checked
                          ? selected.filter((id) => id !== skill.versionId)
                          : [...selected, skill.versionId],
                      )
                    }
                  >
                    <FileZipOutlined />
                    <span>
                      <strong>
                        {skill.name}
                        <small>v{skill.version}</small>
                        {!skill.enabled && <small>已停用</small>}
                      </strong>
                      <span>{skill.description || "未提供用途说明"}</span>
                    </span>
                    <span className="chat-skill-check">{checked && <CheckOutlined />}</span>
                  </button>
                );
              })
            ) : (
              <p className="chat-skill-empty">
                {skills.length
                  ? "没有匹配的 Skill，试试名称或用途中的关键词。"
                  : "此会话未绑定 Skill。可从已绑定 Skill 的 Agent 开始新会话。"}
              </p>
            )}
          </div>
          <footer>
            <span>使用会话创建时固定的版本</span>
            <Button size="small" onClick={close}>
              完成选择
            </Button>
          </footer>
        </section>
      }
    >
      <Button
        ref={trigger}
        type="text"
        size="small"
        icon={<FileZipOutlined />}
        disabled={disabled}
        aria-label="选择 Skills"
        title="选择本次使用的 Skills"
      >
        Skills{selected.length ? ` · ${selected.length}` : ""}
      </Button>
    </Popover>
  );
}
