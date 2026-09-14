import { useAuiState } from "@assistant-ui/react";
import { type PropsWithChildren, useState } from "react";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
  type ThreadGroupPart,
} from "../../shared/assistant-ui";
import { processPreview } from "./process-summary";

type GroupProps = PropsWithChildren<{ group: ThreadGroupPart }>;
export function ChatReasoning({ group, children }: GroupProps) {
  const [open, setOpen] = useState(false);
  const streaming = group.status.type === "running";
  const preview = useAuiState((s) =>
    processPreview(
      group.indices
        .map((index) => {
          const part = s.message.parts[index];
          return part?.type === "reasoning" ? part.text : "";
        })
        .join("\n"),
      streaming,
    ),
  );
  return (
    <ReasoningRoot
      className="chat-process chat-reasoning"
      variant="ghost"
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
    >
      <ReasoningTrigger
        className="chat-process-trigger"
        label={streaming ? "思考中" : "思考"}
        active={streaming}
        summary={preview || (streaming ? "正在整理思路…" : "未记录思考正文")}
      />
      <ReasoningContent aria-busy={streaming}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

// Each call already has its own disclosure. Keep every action visible in order.
export function ChatToolGroup({ children }: GroupProps) {
  return <div className="chat-tool-flow">{children}</div>;
}
