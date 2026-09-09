import type { Run } from "@platform/sdk";
import { Button, Drawer, Table } from "antd";
import { timestamp } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectPages } from "../../shared/data/ProjectData";
import { PageMore, pageItems } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import type { ResourceSelection } from "../../shared/navigation";
import { RunDetails } from "./RunDetails";
import { RunStatus } from "./RunStatus";
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
        size={1100}
        destroyOnHidden
      >
        {selectedId && <RunDetails key={selectedId} projectId={projectId} id={selectedId} />}
      </Drawer>
    </>
  );
}
