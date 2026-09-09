import { ToolOutlined } from "@ant-design/icons";
import type { Tool } from "@platform/sdk";
import { Button, Table, Tag } from "antd";
import { timestamp } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
export function ToolWorkspace({ onCreate }: { onCreate(): void }) {
  const toolsQuery = useProjectQuery("tools"),
    tools = toolsQuery.data ?? [];
  return (
    <QueryState label="工具" query={toolsQuery}>
      <section className="panel">
        <Table<Tool>
          rowKey="id"
          dataSource={tools}
          pagination={false}
          locale={{
            emptyText: (
              <Blank
                title="连接业务能力"
                description="登记只读 JSON 接口，或用内置求和工具验证 Agent 工具调用。"
                action={<Button onClick={() => onCreate()}>登记工具</Button>}
              />
            ),
          }}
          columns={[
            {
              title: "工具",
              dataIndex: "name",
              render: (_, t) => (
                <div className="cell-title">
                  <span className="table-icon">
                    <ToolOutlined key="ToolOutlined" />
                  </span>
                  <div>
                    <strong>{t.name}</strong>
                    <small>{t.description}</small>
                  </div>
                </div>
              ),
            },
            {
              title: "执行方式",
              dataIndex: "kind",
              render: (v) => (v === "sum" ? "内置求和" : v === "mcp" ? "MCP" : "HTTP GET"),
            },
            { title: "能力范围", render: () => <Tag>只读 / 无业务写入</Tag> },
            { title: "版本", render: () => <code>v1</code> },
            { title: "登记时间", dataIndex: "createdAt", render: timestamp },
          ]}
        />
      </section>
    </QueryState>
  );
}
