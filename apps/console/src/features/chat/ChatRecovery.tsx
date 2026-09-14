import { type ResumableClientStorage, useAISDKChat } from "@assistant-ui/ai-sdk";
import { getConversationSession } from "@platform/sdk";
import { validateUIMessages } from "ai";
import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import { unwrap } from "../../shared/api";

export function ChatRecovery({
  projectId,
  conversationId,
  disconnected,
  storage,
  onRun,
  onRecovered,
}: {
  projectId: string;
  conversationId: string;
  disconnected: boolean;
  storage: ResumableClientStorage;
  onRun(id: string | null): void;
  onRecovered(): void;
}) {
  const chat = useAISDKChat();
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const attempts = useRef(0),
    request = useRef<AbortController | null>(null);
  const startingError = useRef(chat?.error);
  const streaming = chat?.status === "submitted" || chat?.status === "streaming";
  const latest = useRef(async () => {});
  latest.current = async () => {
    if (!chat || request.current) return;
    const controller = new AbortController();
    let nativeResume = false;
    startingError.current = chat.error;
    request.current = controller;
    setConnecting(true);
    setNotice("");
    try {
      const session = await unwrap(
        getConversationSession({
          path: { projectId, id: conversationId },
          signal: controller.signal,
        }),
      );
      const messages = await validateUIMessages({ messages: session.messages });
      controller.signal.throwIfAborted();
      // Server history resolves the ambiguous POST case without submitting the
      // optimistic message twice. resumeStream rebuilds one deterministic answer.
      chat.setMessages(messages);
      chat.clearError();
      onRun(session.resumeRun?.id ?? null);
      if (session.resumeRun) {
        if (storage.getStreamId(conversationId) === session.resumeRun.id) {
          await chat.resumeStream();
        } else {
          // A newly discovered run is resumed by useChatRuntime's native storage
          // observer. Calling resumeStream too would open two readers before GET
          // response headers arrive (notably when the original POST lost headers).
          nativeResume = true;
          storage.setStreamId(session.resumeRun.id, conversationId);
        }
      } else {
        storage.clear(conversationId);
        onRecovered();
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(error instanceof Error ? error.message : "暂时无法重新连接");
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted && !nativeResume) setConnecting(false);
    }
  };
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (
      !disconnected ||
      streaming ||
      (chat?.status === "error" && chat.error && chat.error !== startingError.current)
    )
      setConnecting(false);
  }, [disconnected, streaming, chat?.status, chat?.error]);
  useEffect(() => {
    if (!disconnected) {
      attempts.current = 0;
      return;
    }
    if (connecting || streaming) return;
    const reconnect = () => {
      void latest.current();
    };
    window.addEventListener("online", reconnect);
    const timer =
      attempts.current < 2
        ? window.setTimeout(
            () => {
              attempts.current++;
              reconnect();
            },
            attempts.current === 0 ? 1000 : 3000,
          )
        : undefined;
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", reconnect);
    };
  }, [disconnected, connecting, streaming]);
  if (!disconnected) return null;
  return (
    <div className="chat-recovery" role="status">
      <span>
        {connecting || streaming ? "正在恢复对话…" : "连接已中断，后台任务仍可能在执行。"}
        {notice && ` ${notice}`}
      </span>
      <Button size="small" loading={connecting || streaming} onClick={() => void latest.current()}>
        重新连接
      </Button>
    </div>
  );
}
