import type { Run } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Alert, Button, Drawer, Table, Tag } from "antd";
import { timestamp, unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { projectKey, useProjectPages } from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import type { ResourceSelection } from "../../shared/navigation";

const statusNames: Record<Run["status"], string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};
const statusColors: Record<Run["status"], string> = {
  queued: "default",
  running: "processing",
  succeeded: "success",
  failed: "error",
  cancelled: "warning",
};
function RunStatus({ status }: { status: Run["status"] }) {
  return <Tag color={statusColors[status]}>{statusNames[status]}</Tag>;
}
export function RunsWorkspace({
  projectId,
  selectedId,
  onSelect,
}: ResourceSelection & { projectId: string }) {
  const query = useProjectPages("runs", { poll: true }),
    runs = pageItems(query.data);
  return (
    <>
      <QueryState label="运行记录" query={query}>
        <section className="panel">
          <Table<Run>
            rowKey="id"
            dataSource={runs}
            pagination={{ pageSize: 10 }}
            locale={{
              emptyText: (
                <Blank
                  title="还没有运行记录"
                  description="发布 Agent 并发起一次对话后，可以在这里查看执行情况。"
                />
              ),
            }}
            columns={[
              {
                title: "任务",
                dataIndex: "id",
                render: (_, r) => (
                  <Button type="link" onClick={() => onSelect(r.id)}>
                    {r.id.slice(0, 8)}
                  </Button>
                ),
              },
              { title: "Agent", dataIndex: "agentName" },
              {
                title: "发布版本",
                dataIndex: "releaseVersion",
                render: (v) => <code>v{v}</code>,
              },
              {
                title: "状态",
                dataIndex: "status",
                render: (v) => <RunStatus status={v} />,
              },
              { title: "Runtime", dataIndex: "runtimeId" },
              { title: "创建时间", dataIndex: "createdAt", render: timestamp },
              {
                title: "操作",
                render: (_, r) => (
                  <Button type="text" onClick={() => onSelect(r.id)}>
                    查看详情
                  </Button>
                ),
              },
            ]}
          />
        </section>
        <PageMore query={query} count={runs.length} label="运行记录" />
      </QueryState>
      <Drawer
        title="运行详情"
        open={!!selectedId}
        onClose={() => onSelect()}
        size={640}
        destroyOnHidden
      >
        {selectedId && <RunDetails key={selectedId} projectId={projectId} id={selectedId} />}
      </Drawer>
    </>
  );
}
function RunDetails({ projectId, id }: { projectId: string; id: string }) {
  const detailQuery = useQuery({
    queryKey: projectKey(projectId, "runs", id, "detail"),
    queryFn: ({ signal }) => unwrap(api.getRun({ path: { projectId, id }, signal })),
    gcTime: 0,
  });
  const eventsQuery = useInfiniteQuery({
    queryKey: projectKey(projectId, "runs", id, "events"),
    initialPageParam: -1,
    queryFn: ({ signal, pageParam }) =>
      unwrap(api.listRunEvents({ path: { projectId, id }, query: { after: pageParam }, signal })),
    getNextPageParam: (last) => (last.length === 500 ? last.at(-1)?.seq : undefined),
    enabled: !!detailQuery.data,
    gcTime: 0,
  });
  const runDetail = detailQuery.data,
    events = eventsQuery.data?.pages.flat() ?? [],
    eventsMore = eventsQuery.hasNextPage;
  return (
    <QueryState label="运行详情" query={detailQuery}>
      {runDetail && (
        <>
          <div className="run-detail-head">
            <h2>{runDetail.agentName}</h2>
            <RunStatus status={runDetail.status} />
          </div>
          <dl className="detail-grid">
            <dt>运行 ID</dt>
            <dd>
              <code>{runDetail.id}</code>
            </dd>
            <dt>发布版本</dt>
            <dd>v{runDetail.releaseVersion}</dd>
            <dt>Runtime</dt>
            <dd>{runDetail.runtimeId}</dd>
            <dt>开始时间</dt>
            <dd>{timestamp(runDetail.createdAt)}</dd>
          </dl>
          {runDetail.errorCode && (
            <Alert
              type="error"
              title={`运行失败：${runDetail.errorCode}`}
              description="请检查模型连接、服务凭据与 Runtime 状态。"
            />
          )}
          {runDetail.outputText && (
            <section className="run-output">
              <h3>输出</h3>
              <p>{runDetail.outputText}</p>
            </section>
          )}
          <h3>
            执行事件{" "}
            <span className="muted">
              {events.length}
              {eventsMore ? "+" : ""}
            </span>
            <Button
              type="link"
              loading={eventsQuery.isFetching}
              onClick={() => {
                void detailQuery.refetch();
                void eventsQuery.refetch();
              }}
            >
              刷新详情
            </Button>
          </h3>
          {eventsMore && (
            <Button
              loading={eventsQuery.isFetching}
              onClick={() => void eventsQuery.fetchNextPage()}
            >
              加载后续事件
            </Button>
          )}
          <QueryState label="执行事件" query={eventsQuery}>
            <div className="event-list">
              {events.map((e) => (
                <details key={e.seq}>
                  <summary>
                    <span>#{e.seq}</span>
                    <strong>{String(e.chunk.type)}</strong>
                    <small>{timestamp(e.createdAt)}</small>
                  </summary>
                  <pre>{JSON.stringify(e.chunk, null, 2)}</pre>
                </details>
              ))}
            </div>
          </QueryState>
        </>
      )}
    </QueryState>
  );
}
