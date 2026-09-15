import {
  FieldTimeOutlined,
  PauseCircleOutlined,
  SoundOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  ActionBarPrimitive,
  AuiIf,
  type ToolCallMessagePartComponent,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react";
import type { SourceLocation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { App as AntApp, Button, Tag } from "antd";
import { GitBranch } from "lucide-react";
import { useContext, useState } from "react";
import { Link } from "react-router";
import { v4 as uuid } from "uuid";
import { useProjectAccess } from "../../shared/access";
import { unwrap } from "../../shared/api";
import { TooltipIconButton } from "../../shared/assistant-ui";
import { useProjectId } from "../../shared/data/ProjectData";
import { projectPath } from "../../shared/navigation";
import { DocumentReader, locationLabel } from "../knowledge";
import { ChatEditContext } from "./ChatEdit";
import { ResultToolCard, ToolTraceContext } from "./ChatToolCards";
import { readAloudSupported } from "./voice";

type Citation = {
  citationId: string;
  filename: string;
  ordinal: number;
  content: string;
  knowledgeBaseId?: string;
  documentId?: string;
  versionId?: string;
  version?: number;
  location?: SourceLocation | null;
};
/** Runs live outside the project console too (platform assistant); the project
 * dependency is isolated here so footer rendering never requires a provider. */
function TraceLink({ runId }: { runId: string }) {
  const projectId = useProjectId();
  return <Link to={projectPath(projectId, "runs", runId)}>查看本轮轨迹</Link>;
}
export function MessageContext({ trace = false }: { trace?: boolean }) {
  const metadata = useAuiState((s) => s.message.metadata.custom);
  const skills = Array.isArray(metadata?.selectedSkills) ? metadata.selectedSkills : [];
  return (
    <div className="message-context">
      {!trace && skills.length > 0 && <span>本次指定</span>}
      {!trace &&
        skills.map((s) =>
          s && typeof s === "object" && "versionId" in s && "name" in s && "version" in s ? (
            <Tag key={String(s.versionId)}>
              {String(s.name)} · v{String(s.version)}
            </Tag>
          ) : null,
        )}
      {trace && typeof metadata?.runId === "string" && <TraceLink runId={metadata.runId} />}
    </div>
  );
}
function citations(value: unknown): Citation[] {
  if (!value || typeof value !== "object" || !("sources" in value) || !Array.isArray(value.sources))
    return [];
  return value.sources.filter(
    (s): s is Citation =>
      s &&
      typeof s === "object" &&
      typeof s.citationId === "string" &&
      typeof s.filename === "string" &&
      typeof s.ordinal === "number" &&
      typeof s.content === "string",
  );
}
export const ToolCard: ToolCallMessagePartComponent = (props) => {
  const { toolName, result } = props;
  const projectId = useProjectId();
  const canReadSource = useProjectAccess()?.permissions.includes("resource.read") ?? false;
  const [source, setSource] = useState<Citation | null>(null);
  if (toolName === "knowledge_search" && result !== undefined && !props.isError) {
    const sources = citations(result);
    return (
      <ResultToolCard {...props}>
        <section className="chat-citations" aria-label="知识库来源">
          <strong>
            <ToolOutlined /> 知识检索 · {sources.length} 个来源
          </strong>
          {sources.length ? (
            sources.map((s) => (
              <details key={s.citationId} className="chat-citation">
                <summary>
                  <span>
                    {s.filename} ·{" "}
                    {s.location ? locationLabel(s.location) : `片段 ${s.ordinal + 1}`}{" "}
                    {s.version ? `· v${s.version}` : ""}
                  </span>
                  <small>[{s.citationId}]</small>
                </summary>
                <p>{s.content}</p>
                {canReadSource &&
                  typeof s.documentId === "string" &&
                  typeof s.knowledgeBaseId === "string" &&
                  typeof s.versionId === "string" && (
                    <Button size="small" type="link" onClick={() => setSource(s)}>
                      定位原文
                    </Button>
                  )}
              </details>
            ))
          ) : (
            <p>未获得可用资料，请查看工具状态或调整问题。</p>
          )}
        </section>
        {source?.documentId && source.knowledgeBaseId && (
          <DocumentReader
            projectId={projectId}
            kbId={source.knowledgeBaseId}
            documentId={source.documentId}
            versionId={source.versionId}
            location={source.location}
            excerpt={source.content}
            onClose={() => setSource(null)}
          />
        )}
      </ResultToolCard>
    );
  }
  return <ResultToolCard {...props} />;
};

export function AssistantContext() {
  return <MessageContext trace />;
}

/** Derive a new conversation that copies history up to this reply; nothing reruns. */
function AssistantDerive() {
  const trace = useContext(ToolTraceContext);
  const edit = useContext(ChatEditContext);
  const { message } = AntApp.useApp();
  const messageId = useAuiState((s) => s.message.id);
  const running = useAuiState((s) => s.thread.isRunning);
  const [busy, setBusy] = useState(false);
  const fork = edit?.onFork;
  if (!trace || !fork) return null;
  const derive = async () => {
    setBusy(true);
    try {
      const branch = await unwrap(
        api.deriveConversation({
          path: { projectId: trace.projectId, id: trace.conversationId },
          body: { upToMessageId: messageId, requestId: uuid() },
        }),
      );
      fork(branch.id);
      void message?.success?.("已派生新分支，原会话保留");
    } catch (error) {
      void message?.error?.(error instanceof Error ? error.message : "派生失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <TooltipIconButton
      tooltip="从此回复派生新分支"
      disabled={running || busy}
      onClick={() => void derive()}
    >
      <GitBranch />
    </TooltipIconButton>
  );
}

export function MessageExtras() {
  const timing = useMessageTiming();
  return (
    <>
      {readAloudSupported && (
        <>
          <AuiIf condition={(s) => s.message.speech == null}>
            <ActionBarPrimitive.Speak asChild>
              <TooltipIconButton tooltip="朗读这条回复">
                <SoundOutlined />
              </TooltipIconButton>
            </ActionBarPrimitive.Speak>
          </AuiIf>
          <AuiIf condition={(s) => s.message.speech != null}>
            <ActionBarPrimitive.StopSpeaking asChild>
              <TooltipIconButton tooltip="停止朗读">
                <PauseCircleOutlined />
              </TooltipIconButton>
            </ActionBarPrimitive.StopSpeaking>
          </AuiIf>
        </>
      )}
      <AssistantDerive />
      {/* useMessageTiming estimates token counts. Only display observed client latency. */}
      {!!timing?.totalStreamTime && (
        <span className="message-timing" title="浏览器观测耗时">
          <FieldTimeOutlined /> {(timing.totalStreamTime / 1000).toFixed(1)}s
        </span>
      )}
    </>
  );
}
