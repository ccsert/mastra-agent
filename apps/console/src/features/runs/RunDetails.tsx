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
          <p>
            <Link to={projectPath(projectId, "chat", runDetail.conversationId)}>打开关联会话</Link>
          </p>
          {!!runDetail.selectedSkills?.length && (
            <p>
              本次指定：
              {runDetail.selectedSkills.map((s) => (
                <Tag key={s.versionId}>
                  {s.name} · v{s.version}
                </Tag>
              ))}
            </p>
          )}
          {runDetail.inputText && (
            <details className="trace-input">
              <summary>用户输入</summary>
              <pre>{runDetail.inputText}</pre>
            </details>
          )}
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
            <RunTrajectory events={events} status={runDetail.status} complete={!eventsMore} />
          </QueryState>
        </>
      )}
    </QueryState>
  );
}
