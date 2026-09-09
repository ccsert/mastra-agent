import type { ConversationCapabilities } from "@platform/sdk";

export type ChatCommand = {
  id: string;
  label: string;
  description: string;
  skillVersionId?: string;
  disabled?: boolean;
};
type CommandProvider = {
  name: string;
  entries(skills: ConversationCapabilities["skills"]): ChatCommand[];
};
// Providers describe discoverable actions; the server owns the corresponding authorization.
const providers: CommandProvider[] = [
  {
    name: "skill",
    entries: (skills) =>
      skills.map((s) => ({
        id: `skill:${s.versionId}`,
        label: `/skill ${s.name}`,
        description: `v${s.version} · ${s.enabled ? s.description : "此版本已停用"}`,
        skillVersionId: s.versionId,
        disabled: !s.enabled,
      })),
  },
];
export function chatCommands(
  text: string,
  skills: ConversationCapabilities["skills"],
): ChatCommand[] {
  const query = text.replace(/^\//, "").trim().toLowerCase();
  return providers
    .flatMap((provider) => provider.entries(skills))
    .filter((command) => `${command.label} ${command.description}`.toLowerCase().includes(query));
}
