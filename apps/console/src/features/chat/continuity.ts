import type { ResumableClientStorage } from "@assistant-ui/ai-sdk";
import { readSessionValue, writeSessionValue } from "../../shared/data/session-storage";

export type ConversationDraft = { text: string; skills: string[] };
export const draftStorageKey = (scope: string | undefined, id: string) =>
  scope ? `${scope}:${id}:draft` : undefined;
export function readDraft(key: string | undefined): ConversationDraft | undefined {
  const value = readSessionValue(key);
  if (!value || typeof value !== "object" || !("text" in value) || !("skills" in value)) return;
  if (
    typeof value.text !== "string" ||
    value.text.length > 16000 ||
    !Array.isArray(value.skills) ||
    value.skills.length > 10 ||
    !value.skills.every((id) => typeof id === "string" && id.length <= 100)
  )
    return;
  return { text: value.text, skills: value.skills };
}
export function saveDraft(key: string | undefined, draft: ConversationDraft) {
  writeSessionValue(key, draft.text || draft.skills.length ? draft : undefined);
}

/** The server session snapshot discovers accepted runs even if the POST headers were lost. */
export function createRunStorage(initial: string | null): ResumableClientStorage {
  let id = initial;
  const listeners = new Set<() => void>();
  return {
    getStreamId: () => id,
    setStreamId(next) {
      id = next;
      for (const listener of listeners) listener();
    },
    clear() {
      id = null;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
