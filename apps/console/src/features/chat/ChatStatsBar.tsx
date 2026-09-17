import { DatabaseOutlined, FieldTimeOutlined } from "@ant-design/icons";
import { getConversationStats } from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import Tooltip from "antd/es/tooltip";
import { unwrap } from "../../shared/api.ts";
import { projectKey } from "../../shared/data/ProjectData.tsx";

const count = (value: number) => value.toLocaleString();

function tokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K tok`;
  return `${count(value)} tok`;
}

/** Conversation totals below the composer. Every figure is a sum of
 * provider-reported usage or measured model-transport time; a value the
 * provider never reported is omitted rather than shown as zero. */
export function ChatStatsBar({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const stats = useQuery({
    queryKey: projectKey(projectId, "conversations", conversationId, "stats"),
    queryFn: ({ signal }) =>
      unwrap(getConversationStats({ path: { projectId, id: conversationId }, signal })),
    staleTime: 10_000,
    retry: false,
  });
  const data = stats.data;
  if (!data?.turns) return null;
  // Generated types mark defaulted fields optional; null and undefined both
  // mean "the provider never reported this".
  const output = data.outputTokens ?? null;
  const input = data.inputTokens ?? null;
  const cached = data.cachedInputTokens ?? null;
  const rate = output !== null && data.modelMs ? Math.round(output / (data.modelMs / 1000)) : null;
  const total = (input ?? 0) + (output ?? 0);
  const cache = cached !== null && input ? (cached / input) * 100 : null;
  return (
    <div className="chat-stats">
      <span className="chat-stats-item">
        <FieldTimeOutlined aria-hidden="true" />
        {data.turns} 轮 · {count(data.steps)} 步{rate !== null && ` · ${count(rate)} tok/s`}
      </span>
      {total > 0 && (
        <span className="chat-stats-item">
          <DatabaseOutlined aria-hidden="true" />
          <Tooltip
            title={`模型供应方报告的累计用量：输入 ${count(input ?? 0)} · 输出 ${count(output ?? 0)}${cached !== null ? ` · 缓存读取 ${count(cached)}` : ""}；速率按已记录的模型传输耗时计算。`}
          >
            <span>
              {tokens(total)}
              {cache !== null && ` · 缓存命中 ${cache.toFixed(1)}%`}
            </span>
          </Tooltip>
        </span>
      )}
    </div>
  );
}
