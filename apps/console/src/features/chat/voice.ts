import { WebSpeechDictationAdapter, WebSpeechSynthesisAdapter } from "@assistant-ui/react";

/**
 * Read-aloud and dictation are performed entirely by the browser's Web Speech
 * API. Nothing reaches this platform's contracts, so there is no server state a
 * transcript or a spoken reply could disagree with, and no model call is billed.
 *
 * Both capabilities are optional and browser-dependent. The support checks and
 * the adapters are derived from the same evaluation, and the buttons are gated
 * on the adapter existing rather than on capabilities the message declares.
 * `ActionBarPrimitive.Speak` alone is not enough: it only inspects the message,
 * so with no adapter it stays clickable and silently does nothing.
 */
const speechAdapter =
  typeof window !== "undefined" && "speechSynthesis" in window
    ? new WebSpeechSynthesisAdapter()
    : undefined;
const dictationAdapter = WebSpeechDictationAdapter.isSupported()
  ? new WebSpeechDictationAdapter({ language: "zh-CN" })
  : undefined;

export const readAloudSupported = speechAdapter !== undefined;
export const dictationSupported = dictationAdapter !== undefined;

export const voiceAdapters = {
  ...(speechAdapter ? { speech: speechAdapter } : {}),
  ...(dictationAdapter ? { dictation: dictationAdapter } : {}),
};
