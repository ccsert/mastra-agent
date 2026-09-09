import * as api from "@platform/sdk";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Alert, Button, Tag } from "antd";
import { useEffect } from "react";
import { Link } from "react-router";
import { timestamp, unwrap } from "../../shared/api";
import { projectKey } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { projectPath } from "../../shared/navigation";
import { RunStatus } from "./RunStatus";
import { RunTrajectory } from "./RunTrajectory";

export function RunDetails({ projectId, id }: { projectId: string; id: string }) {
  const detailQuery = useQuery({
    queryKey: projectKey(projectId, "runs", id, "detail"),
    queryFn: ({ signal }) => unwrap(api.getRun({ path: { projectId, id }, signal })),
    gcTime: 0,
    refetchInterval: (q) =>
      q.state.data && ["queued", "running"].includes(q.state.data.status) ? 1500 : false,
  });
  const eventsQuery = useInfiniteQuery({
    queryKey: projectKey(projectId, "runs", id, "events"),
    initialPageParam: -1,
    queryFn: ({ signal, pageParam }) =>
      unwrap(api.listRunEvents({ path: { projectId, id }, query: { after: pageParam }, signal })),
    getNextPageParam: (last) => (last.length === 500 ? last.at(-1)?.seq : undefined),
    enabled: !!detailQuery.data,
    refetchInterval:
      detailQuery.data && ["queued", "running"].includes(detailQuery.data.status) ? 1500 : false,
    gcTime: 0,
  });
  const runDetail = detailQuery.data,
    events = eventsQuery.data?.pages.flat() ?? [],
    eventsMore = eventsQuery.hasNextPage;
  const refetchEvents = eventsQuery.refetch;
  const status = runDetail?.status;
  useEffect(() => {
    if (status && !["queued", "running"].includes(status)) void refetchEvents();
  }, [status, refetchEvents]);
  return (
    <QueryState label="运行详情" query={detailQuery}>
      {runDetail && (
        <section className="run-details">
          <header className="run-detail-head">
            <div>
              <h2>{runDetail.agentName}</h2>
              <small>
                v{runDetail.releaseVersion} · {runDetail.runtimeId} ·{" "}
                {timestamp(runDetail.createdAt)}
              </small>
            </div>
            <div>
              <RunStatus status={runDetail.status} />
              <Button
                size="small"
                loading={eventsQuery.isFetching}
                onClick={() => {
                  void detailQuery.refetch();
                  void eventsQuery.refetch();
                }}
              >
                刷新详情
              </Button>
            </div>
          </header>
          <div className="run-context-bar">
            <details>
              <summary>运行信息</summary>
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
            </details>
            <Link to={projectPath(projectId, "chat", runDetail.conversationId)}>打开关联会话</Link>
            {!!runDetail.selectedSkills?.length && (
              <span>
                本次指定：
                {runDetail.selectedSkills.map((s) => (
                  <Tag key={s.versionId}>
                    {s.name} · v{s.version}
                  </Tag>
                ))}
              </span>
            )}
          </div>
          {runDetail.errorCode && (
            <Alert
              type="error"
              title={`运行失败：${runDetail.errorCode}`}
              description="请检查模型连接、服务凭据与 Runtime 状态。"
            />
          )}
          {eventsMore && (
            <Button
              loading={eventsQuery.isFetching}
              onClick={() => void eventsQuery.fetchNextPage()}
            >
              加载后续事件
            </Button>
          )}
          <QueryState label="执行事件" query={eventsQuery}>
            <RunTrajectory
              events={events}
              status={runDetail.status}
              complete={!eventsMore}
              run={runDetail}
            />
          </QueryState>
          {runDetail.outputText && (
            <details className="trace-output-raw">
              <summary>汇总输出原文</summary>
              <pre>{runDetail.outputText}</pre>
            </details>
          )}
        </section>
      )}
    </QueryState>
  );
}
