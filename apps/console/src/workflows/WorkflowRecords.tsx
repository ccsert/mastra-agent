import type { WorkflowRelease } from "@platform/sdk";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Table } from "antd";
import { timestamp } from "../api";
import { PageMore, pageItems } from "../data/pages";
import { QueryState } from "../data/QueryState";
import { workflowQueries } from "../data/workflows";
import { Status } from "./Status";
export function WorkflowRuns({
  projectId,
  id,
  enabled,
  onDetail,
}: {
  projectId: string;
  id: string;
  enabled: boolean;
  onDetail(id: string): void;
}) {
  const query = useInfiniteQuery({ ...workflowQueries.runs(projectId, id), enabled }),
    runs = pageItems(query.data);
  return (
    <QueryState label="工作流运行记录" query={query}>
      <Table
        rowKey="id"
        dataSource={runs}
        scroll={{ x: 650 }}
        columns={[
          { title: "开始时间", render: (_, r) => timestamp(r.createdAt) },
          { title: "版本", render: (_, r) => `v${r.version}` },
          { title: "状态", render: (_, r) => <Status value={r.status} /> },
          { title: "错误原因", dataIndex: "errorCode", render: (v) => v ?? "—" },
          {
            title: "操作",
            render: (_, r) => <Button onClick={() => onDetail(r.id)}>查看节点详情</Button>,
          },
        ]}
      />
      <PageMore query={query} count={runs.length} />
    </QueryState>
  );
}
export function WorkflowReleases({
  projectId,
  id,
  enabled,
  onRun,
}: {
  projectId: string;
  id: string;
  enabled: boolean;
  onRun(release: WorkflowRelease): void;
}) {
  const query = useInfiniteQuery({ ...workflowQueries.releases(projectId, id), enabled }),
    releases = pageItems(query.data);
  return (
    <QueryState label="发布版本" query={query}>
      <Table
        rowKey="id"
        dataSource={releases}
        scroll={{ x: 650 }}
        columns={[
          { title: "版本", render: (_, r) => <strong>v{r.version}</strong> },
          { title: "发布时间", render: (_, r) => timestamp(r.createdAt) },
          {
            title: "固定能力",
            render: (_, r) =>
              `${r.snapshot.agents.length} 个 Agent · ${r.snapshot.tools.length} 个工具`,
          },
          {
            title: "操作",
            render: (_, r) => <Button onClick={() => onRun(r)}>运行此版本</Button>,
          },
        ]}
      />
      <PageMore query={query} count={releases.length} label="版本" />
    </QueryState>
  );
}
