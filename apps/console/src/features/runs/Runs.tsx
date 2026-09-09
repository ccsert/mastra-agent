import * as api from "@platform/sdk";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Table } from "antd";
import { Link, Navigate } from "react-router";
import { timestamp, unwrap, unwrapPage } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { projectKey } from "../../shared/data/ProjectData";
import { PageMore, pageItems, pageOptions } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import { conversationTracePath, type ResourceSelection } from "../../shared/navigation";
import { RunStatus } from "./RunStatus";

function RunLocation({ projectId, id }: { projectId: string; id: string }) {
  const query = useQuery({
    queryKey: projectKey(projectId, "runs", id, "detail"),
    queryFn: ({ signal }) => unwrap(api.getRun({ path: { projectId, id }, signal }), signal),
    gcTime: 0,
  });
  return (
    <QueryState label="运行所属会话" query={query}>
      {query.data && (
        <Navigate replace to={conversationTracePath(projectId, query.data.conversationId, id)} />
      )}
    </QueryState>
  );
}
export function RunsWorkspace({
  projectId,
  selectedId,
}: ResourceSelection & { projectId: string }) {
  const query = useInfiniteQuery({
    ...pageOptions(projectKey(projectId, "conversations", "run-summaries"), (cursor, signal) =>
      unwrapPage(
        api.listConversationRunSummaries({
          path: { projectId },
          query: { cursor, limit: 20 },
          signal,
        }),
      ),
    ),
    enabled: !selectedId,
    refetchInterval: 3000,
  });
  const sessions = pageItems(query.data);
  if (selectedId) return <RunLocation projectId={projectId} id={selectedId} />;
  return (
    <QueryState label="会话运行记录" query={query}>
      <section className="panel">
        <Table<api.ConversationRunSummary>
          rowKey="id"
          dataSource={sessions}
          pagination={false}
          locale={{
            emptyText: (
              <Blank
                title="还没有运行记录"
                description="发布 Agent 并发起对话后，在这里查看会话的全部轮次。"
              />
            ),
          }}
          columns={[
            {
              title: "会话",
              dataIndex: "title",
              render: (_, s) => <Link to={conversationTracePath(projectId, s.id)}>{s.title}</Link>,
            },
            { title: "Agent", dataIndex: "agentName" },
            { title: "轮次", dataIndex: "runCount", render: (v) => `${v} 轮` },
            {
              title: "最近一轮",
              dataIndex: "latestStatus",
              render: (v) => <RunStatus status={v} />,
            },
            { title: "最后运行时间", dataIndex: "lastRunAt", render: timestamp },
            {
              title: "操作",
              render: (_, s) => (
                <Link to={conversationTracePath(projectId, s.id)}>查看会话轨迹</Link>
              ),
            },
          ]}
        />
      </section>
      <PageMore query={query} count={sessions.length} label="会话" />
    </QueryState>
  );
}
