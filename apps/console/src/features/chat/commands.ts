import type { Unstable_SlashCommand, Unstable_TriggerMatcher } from "@assistant-ui/react";
import type { ConversationCapabilities } from "@platform/sdk";

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
      label: `/skill ${s.name}`,
      description: `v${s.version} · ${s.description}`,
      execute: () => {
        if (s.enabled && !selected.includes(s.versionId) && selected.length < 10)
          onSelect([...selected, s.versionId]);
      },
    }));
}

// Extend the official trigger matcher only for the multiword /skill query.
// The official popover still owns selection, Escape, IME, and keyboard navigation.
export const skillTriggerMatcher: Unstable_TriggerMatcher = (text, char, cursor) => {
  const offset = text.lastIndexOf("\n", cursor - 1) + 1;
  if (cursor <= offset || !text.startsWith(char, offset)) return null;
  return { query: text.slice(offset + char.length, cursor), offset, endOffset: cursor };
};
