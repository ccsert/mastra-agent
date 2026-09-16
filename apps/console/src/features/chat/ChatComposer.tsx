import {
  ArrowUpOutlined,
  AudioMutedOutlined,
  AudioOutlined,
  BorderOutlined,
  ClearOutlined,
  CompressOutlined,
  FileZipOutlined,
  InfoCircleOutlined,
  PieChartOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import {
  AuiIf,
  ComposerPrimitive,
  unstable_useComposerInputHistory,
  unstable_useSlashCommandAdapter,
  useAuiState,
} from "@assistant-ui/react";
import type { ConversationCapabilities } from "@platform/sdk";
import { Button, Tag, Tooltip } from "antd";

import { ComposerTriggerPopover, TooltipIconButton } from "../../shared/assistant-ui";
import { skillCommands, skillTriggerMatcher, systemCommands } from "./commands";
import { SkillPicker } from "./SkillPicker";
import { dictationSupported } from "./voice";

export function ChatComposer({
  skills,
  selected,
  onSelect,
  cancelRun,
  cancelling,
  recovering = false,
  loading,
  error,
  onRetry,
  onCommand,
  contextUsage,
}: {
  skills: ConversationCapabilities["skills"];
  selected: string[];
  onSelect(ids: string[]): void;
  /** Cancels the run on the platform; stopping the stream alone leaves it running. */
  cancelRun(): void;
  cancelling: boolean;
  recovering?: boolean;
  loading: boolean;
  error: boolean;
  onRetry(): void;
  onCommand?: (text: string) => boolean;
  contextUsage?: { tokens?: number | null; window?: number | null };
}) {
  const composerText = useAuiState((s) => s.composer.text);
  const running = useAuiState((s) => s.thread.isRunning) || recovering;
  // ArrowUp/ArrowDown recall of previously sent messages. The hook derives the
  // ring from the current thread's user messages, so it needs no persistence,
  // and it yields to an open popover — which is what keeps it compatible with
  // the `/` slash-command menu below.
  const history = unstable_useComposerInputHistory();
  const dictation = dictationSupported;
  const unavailable = selected.some(
    (id) => !skills.some((skill) => skill.versionId === id && skill.enabled),
  );
  const slash = unstable_useSlashCommandAdapter({
    commands: [
      ...(onCommand &&
      /^\s*\/[^/]*$/.test(composerText) &&
      !/^\s*\/skill(?:\s|$)/i.test(composerText)
        ? systemCommands(onCommand, running)
        : []),
      ...(running ? [] : skillCommands(skills, selected, onSelect)),
    ],
    iconMap: {
      clear: ClearOutlined,
      compact: CompressOutlined,
      context: InfoCircleOutlined,
      help: QuestionCircleOutlined,
      stop: BorderOutlined,
      skill: FileZipOutlined,
    },
    removeOnExecute: true,
    fallbackIcon: FileZipOutlined,
  });
  const emptyLabel = error
    ? "无法加载 Skills，请在 Skills 面板中重试。"
    : selected.length >= 10
      ? "一次任务最多指定 10 个 Skill。"
      : skills.some((s) => s.enabled)
        ? "没有匹配的可选 Skill；已选择或已停用版本不会重复列出。"
        : "此会话没有可用 Skill。请绑定并发布 Agent，再创建新会话。";
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        className="composer assistant-elements"
        aria-busy={cancelling}
        onSubmitCapture={(e) => {
          if (onCommand?.(composerText)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <ComposerTriggerPopover
          char="/"
          {...slash}
          matcher={skillTriggerMatcher}
          isLoading={loading && !onCommand}
          className="chat-skill-slash"
          aria-label="对话指令与 Skills"
          backLabel="返回"
          emptyItemsLabel={emptyLabel}
          emptyCategoriesLabel={emptyLabel}
          loadingLabel="正在加载会话能力…"
        />
        {!!selected.length && (
          <section className="chat-command-selection" aria-label="本次指定的 Skills">
            <span className="chat-skill-selection-label">本次使用</span>
            {selected.map((id) => {
              const skill = skills.find((s) => s.versionId === id);
              return (
                <Tag
                  key={id}
                  closable={!running}
                  onClose={() => onSelect(selected.filter((s) => s !== id))}
                  title={skill?.description}
                  color={loading || error || skill?.enabled ? undefined : "error"}
                  icon={<FileZipOutlined />}
                >
                  {skill?.name ?? (loading || error ? "待确认的 Skill" : "不可用的 Skill")}
                  {skill && ` · v${skill.version}`}
                </Tag>
              );
            })}
            <Button type="text" size="small" disabled={running} onClick={() => onSelect([])}>
              清空
            </Button>
          </section>
        )}
        {selected.length > 0 && !loading && (error || unavailable) && (
          <p className="chat-skill-warning" role="status">
            {error
              ? "尚未确认所选 Skill 是否可用，请重新加载或移除选择。"
              : "所选 Skill 已停用或不再可用，请移除后发送。"}
          </p>
        )}
        <ComposerPrimitive.Input
          {...history}
          aria-label="消息"
          placeholder="发送消息，或输入 / 查看指令与 Skills…"
          className="composer-input"
          rows={1}
          enterKeyHint="send"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <SkillPicker
              skills={skills}
              selected={selected}
              onSelect={onSelect}
              disabled={running}
              loading={loading}
              error={error}
              onRetry={onRetry}
            />
            {dictation && (
              <AuiIf condition={(s) => s.composer.dictation == null}>
                <ComposerPrimitive.Dictate asChild>
                  <TooltipIconButton tooltip="语音输入">
                    <AudioOutlined />
                  </TooltipIconButton>
                </ComposerPrimitive.Dictate>
              </AuiIf>
            )}
            {dictation && (
              <AuiIf condition={(s) => s.composer.dictation != null}>
                <ComposerPrimitive.StopDictation asChild>
                  <TooltipIconButton tooltip="停止语音输入" className="text-destructive">
                    <AudioMutedOutlined />
                  </TooltipIconButton>
                </ComposerPrimitive.StopDictation>
              </AuiIf>
            )}
          </div>
          <div className="composer-submit">
            {contextUsage?.window != null && contextUsage.tokens != null && (
              <Tooltip
                title={`上下文占用（最近一次实测）· 达到窗口 75% 时下次运行自动压缩历史，/compact 可立即压缩`}
              >
                <button
                  type="button"
                  className={`composer-usage ${ratioLevel(contextUsage.tokens, contextUsage.window)}`}
                  aria-label="上下文占用"
                  onClick={(event) => {
                    event.preventDefault();
                    onCommand?.("/context");
                  }}
                >
                  <PieChartOutlined />
                  {formatTokens(contextUsage.tokens)} / {formatTokens(contextUsage.window)}
                </button>
              </Tooltip>
            )}
            <span className="composer-key-hint">Shift + Enter 换行</span>
            {!running && (
              <ComposerPrimitive.Send
                asChild
                onClickCapture={(e) => {
                  if (onCommand?.(composerText)) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
              >
                <TooltipIconButton tooltip="发送消息" className="send-button" variant="default">
                  <ArrowUpOutlined />
                </TooltipIconButton>
              </ComposerPrimitive.Send>
            )}
            {running && (
              <button
                type="button"
                className="send-button cancel-button"
                aria-label={cancelling ? "正在停止" : "停止生成"}
                disabled={cancelling}
                onClick={(event) => {
                  event.preventDefault();
                  cancelRun();
                }}
              >
                <BorderOutlined />
              </button>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** Matches the automatic-compaction trigger: warn at 75% of the window. */
function ratioLevel(tokens: number, window: number) {
  if (window <= 0) return "";
  const ratio = tokens / window;
  if (ratio >= 1) return "danger";
  if (ratio >= 0.75) return "warn";
  return "";
}
