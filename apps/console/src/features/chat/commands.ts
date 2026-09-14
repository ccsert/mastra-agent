import type { Unstable_SlashCommand, Unstable_TriggerMatcher } from "@assistant-ui/react";
import type { ConversationCapabilities } from "@platform/sdk";

export const chatCommands = [
  { name: "clear", description: "开启干净会话，原始记录仍保留", icon: "clear" },
  { name: "compact", description: "生成历史摘要，释放后续模型上下文", icon: "compact" },
  { name: "context", description: "查看上下文与当前摘要", icon: "context" },
  { name: "help", description: "查看全部对话指令", icon: "help" },
  { name: "stop", description: "停止当前运行", icon: "stop" },
  { name: "skills", description: "查看本会话可用的 Skills", icon: "skill" },
] as const;
export type ChatCommand = (typeof chatCommands)[number]["name"];
export function parseChatCommand(text: string): { name: ChatCommand; argument: string } | null {
  const match = /^\/(clear|new|compact|context|help|stop|skills)(?:\s+([\s\S]*))?$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    name: (match[1].toLowerCase() === "new" ? "clear" : match[1].toLowerCase()) as ChatCommand,
    argument: (match[2] ?? "").trim(),
  };
}
export function systemCommands(
  execute: (text: string) => void,
  running: boolean,
): Unstable_SlashCommand[] {
  return chatCommands
    .filter((c) => !running || !["clear", "compact"].includes(c.name))
    .map((c) => ({
      id: `command:${c.name}`,
      label: `/${c.name}`,
      description: c.description,
      icon: c.icon,
      execute: () => execute(`/${c.name}`),
    }));
}

export function skillCommands(
  skills: ConversationCapabilities["skills"],
  selected: string[],
  onSelect: (ids: string[]) => void,
): Unstable_SlashCommand[] {
  if (selected.length >= 10) return [];
  return skills
    .filter((s) => s.enabled && !selected.includes(s.versionId))
    .map((s) => ({
      id: `skill:${s.versionId}`,
      label: `${parseChatCommand(`/${s.name}`) ? "/skill " : "/"}${s.name}`,
      description: `v${s.version} · ${s.description}`,
      execute: () => {
        if (s.enabled && !selected.includes(s.versionId) && selected.length < 10)
          onSelect([...selected, s.versionId]);
      },
    }));
}

// Match inline /name and the existing /skill name alias, while leaving URLs,
// file paths and fenced code to the normal text editor.
export const skillTriggerMatcher: Unstable_TriggerMatcher = (text, char, cursor) => {
  const prefix = text.slice(0, cursor);
  if ((prefix.match(/^\s*```/gm)?.length ?? 0) % 2) return null;
  const match = /(?:^|[\s，。；：])\/(skill(?:[ \t]+[^\n/]*)?|[^\s/]*)$/u.exec(prefix);
  if (!match) return null;
  const offset = prefix.lastIndexOf(char);
  const query = (match[1] ?? "").replace(/^skill(?:[ \t]+|$)/i, "");
  return { query, offset, endOffset: cursor };
};
