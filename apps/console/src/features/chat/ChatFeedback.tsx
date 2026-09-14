import { submitRunFeedback } from "@platform/sdk";
import { MessageSquarePlus } from "lucide-react";
import { useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { unwrap } from "../../shared/api";

/** Separate from the ordinary draft: submitting feedback must never start a second run. */
export function ChatFeedback({
  projectId,
  runId,
  disabled = false,
}: {
  projectId: string;
  runId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const submission = useRef<{ text: string; requestId: string } | null>(null);
  async function submit() {
    if (!text.trim() || busy || disabled) return;
    const value = text.trim();
    if (submission.current?.text !== value) submission.current = { text: value, requestId: uuid() };
    setBusy(true);
    setNotice("");
    try {
      await unwrap(submitRunFeedback({ path: { projectId, id: runId }, body: submission.current }));
      setText("");
      submission.current = null;
      setNotice("要求已保存，执行器将在下一次模型请求前读取；最终回复已经生成时，请在下一轮继续。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败，可重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="chat-feedback" aria-label="补充任务要求">
      <button
        type="button"
        className="chat-workspace-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MessageSquarePlus size={14} />
        补充要求
      </button>
      {open && (
        <div className="chat-feedback-body">
          <p>补充当前任务的方向或验收条件。当前工具会先执行完，停止任务请使用停止按钮。</p>
          <textarea
            aria-label="补充要求内容"
            value={text}
            maxLength={2000}
            rows={3}
            disabled={busy || disabled}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || disabled || !text.trim()}
            onClick={() => void submit()}
          >
            {busy ? "正在保存…" : "保存补充要求"}
          </button>
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
    </section>
  );
}
