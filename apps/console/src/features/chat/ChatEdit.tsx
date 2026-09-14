import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { editConversationMessage } from "@platform/sdk";
import { GitBranch, Send, X } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { unwrap } from "../../shared/api";

export const ChatEditContext = createContext<{
  projectId: string;
  conversationId: string;
  disabled: boolean;
  onFork?: (id: string) => void;
} | null>(null);

/** The native message composer owns editing text and cancellation. The server
 * branches saved history atomically; it never accepts a client-made transcript. */
export function ChatEdit() {
  const context = useContext(ChatEditContext);
  const messageId = useAuiState((s) => s.message.id);
  const text = useAuiState((s) => s.composer.text);
  const running = useAuiState((s) => s.thread.isRunning);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef({ input: "", requestId: "" });
  const disabled = sending || running || context?.disabled || !context?.onFork;
  async function send() {
    if (disabled || !context || !text.trim() || text.trim().length > 16000) return;
    const input = text.trim();
    if (attempt.current.input !== input) attempt.current = { input, requestId: uuid() };
    setSending(true);
    setError("");
    try {
      const branch = await unwrap(
        editConversationMessage({
          path: { projectId: context.projectId, id: context.conversationId },
          body: { messageId, ...attempt.current },
        }),
      );
      context.onFork?.(branch.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "编辑发送失败");
    } finally {
      setSending(false);
    }
  }
  return (
    <ComposerPrimitive.Root
      className="chat-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <ComposerPrimitive.Input
        aria-label="编辑消息"
        submitMode="none"
        autoFocus
        disabled={sending}
        maxLength={16000}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="chat-edit-footer">
        <small>
          <GitBranch aria-hidden="true" /> 原消息和后续回复会保留
        </small>
        <ComposerPrimitive.Cancel asChild>
          <button type="button" disabled={sending}>
            <X aria-hidden="true" />
            取消编辑
          </button>
        </ComposerPrimitive.Cancel>
        <button type="submit" disabled={disabled || !text.trim()}>
          <Send aria-hidden="true" />
          {sending ? "正在发送…" : "保存并发送"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </ComposerPrimitive.Root>
  );
}
