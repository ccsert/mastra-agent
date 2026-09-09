import { ApiOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { McpServer } from "@platform/sdk";
import { Button, Drawer, Empty, Space, Table, Tag } from "antd";
import { useState } from "react";
import { useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { McpCreate } from "./McpCreate";
import { McpDetails } from "./McpDetails";
export function McpWorkspace({ projectId }: { projectId: string }) {
  const serversQuery = useProjectQuery("mcpServers"),
    servers = serversQuery.data ?? [],
    toolsQuery = useProjectQuery("tools"),
    tools = toolsQuery.data ?? [],
    refresh = useProjectRefresh();
  const [selectedId, setSelectedId] = useState<string>(),
    [create, setCreate] = useState(false);
  const selected = servers.find((server) => server.id === selectedId);
  return (
    <>
      <section className="mcp-intro">
        <div>
          <Tag color="green">业务能力接入</Tag>
          <h2>让 Agent 连接你的业务系统</h2>
          <p>登记 MCP 服务，发现能力并审阅后导入工具，再绑定到 Agent 发布使用。</p>
        </div>
        <Space>
          <Button
            aria-label="刷新 MCP 服务"
            icon={<ReloadOutlined />}
            onClick={() => void refresh("mcpServers", "tools")}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreate(true)}>
            登记 MCP 服务
          </Button>
        </Space>
      </section>
      <QueryState label="工具" query={toolsQuery}>
        {null}
      </QueryState>
      <QueryState label="MCP 服务" query={serversQuery}>
        <section className="panel">
          <Table<McpServer>
            rowKey="id"
            dataSource={servers}
            pagination={false}
            scroll={{ x: 760 }}
            locale={{
              emptyText: (
                <Empty description="还没有 MCP 服务。先登记一个能由 Runtime 访问的 Streamable HTTP 地址。" />
              ),
            }}
            columns={[
              {
                title: "服务",
                render: (_, s) => (
                  <div className="cell-title">
                    <span className="table-icon">
                      <ApiOutlined />
                    </span>
                    <div>
                      <strong>{s.name}</strong>
                      <small>{s.url}</small>
                    </div>
                  </div>
                ),
              },
              {
                title: "状态",
                render: (_, s) => (
                  <Tag color={s.enabled ? "green" : "default"}>
                    {s.enabled ? "已启用" : "已停用"}
                  </Tag>
                ),
              },
              {
                title: "工具",
                render: (_, s) =>
                  `${tools.filter((t) => t.mcp?.serverId === s.id).length} 个已导入`,
              },
              { title: "凭据", render: (_, s) => (s.hasCredential ? "已配置" : "无认证") },
              {
                title: "操作",
                render: (_, s) => (
                  <Button type="link" onClick={() => setSelectedId(s.id)}>
                    管理能力
                  </Button>
                ),
              },
            ]}
          />
        </section>
      </QueryState>
      <p className="form-note">
        当前开放只读查询。服务声明仅供参考，导入时需要由维护者确认业务性质。写入工具的审批链路后续接入。
      </p>
      {create && (
        <McpCreate
          projectId={projectId}
          onClose={() => setCreate(false)}
          onCreated={(server) => {
            setCreate(false);
            setSelectedId(server.id);
          }}
        />
      )}
      <Drawer
        title={selected?.name ?? "MCP 服务"}
        open={!!selected}
        onClose={() => setSelectedId(undefined)}
        size="min(860px, 100vw)"
        destroyOnHidden
      >
        {selected && <McpDetails key={selected.id} server={selected} tools={tools} />}
      </Drawer>
    </>
  );
}
