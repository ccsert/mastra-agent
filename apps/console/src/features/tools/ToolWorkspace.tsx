import { EditOutlined, ToolOutlined } from "@ant-design/icons";
import type { Tool } from "@platform/sdk";
import { Button, Drawer, Table, Tabs, Tag, Tooltip } from "antd";
import { useState } from "react";
import { useProjectAccess } from "../../shared/access";
import { timestamp } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { usePageActionTargets } from "../../shared/PageActions";
import { SystemCapabilityDirectory } from "../capabilities/index";

const kindLabels = { sum: "内置求和", http_get: "HTTP GET", mcp: "MCP" } as const;
function ProjectTools({ onCreate, onEdit }: { onCreate(): void; onEdit(tool: Tool): void }) {
  const [selected, setSelected] = useState<Tool>();
  const access = useProjectAccess(),
    canManage = access?.permissions.includes("resource.manage") ?? false;
  const toolsQuery = useProjectQuery("tools"),
    tools = toolsQuery.data ?? [];
  return (
    <>
      <QueryState label="工具" query={toolsQuery}>
        <section className="panel">
          <Table<Tool>
            scroll={{ x: 1000 }}
            rowKey="id"
            dataSource={tools}
            pagination={false}
            locale={{
              emptyText: (
                <Blank
                  title="连接业务能力"
                  description="登记只读 JSON 接口，或用内置求和工具验证 Agent 工具调用。"
                  action={
                    <Button disabled={!canManage} onClick={() => onCreate()}>
                      登记工具
                    </Button>
                  }
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
                render: (v: Tool["kind"]) => <Tag>{kindLabels[v]}</Tag>,
              },
              {
                title: "接口地址",
                dataIndex: "url",
                ellipsis: true,
                // `sum` runs inside the platform, so there is no address to show.
                render: (v: string, t) =>
                  t.kind === "sum" ? <span className="muted">平台内置</span> : <code>{v}</code>,
              },
              {
                title: "凭据",
                dataIndex: "hasCredential",
                render: (v: boolean, t) =>
                  t.kind === "sum" ? (
                    <span className="muted">不需要</span>
                  ) : (
                    <Tag color={v ? "success" : "default"}>{v ? "已加密保存" : "未设置"}</Tag>
                  ),
              },
              {
                // The registry's own record, shown as stored: an authored tool
                // is read-only by construction, while an imported MCP tool is
                // read-only only when the remote service declared it so.
                title: "能力范围",
                dataIndex: "writes",
                render: (v: boolean, t) =>
                  t.kind !== "mcp" ? (
                    <Tag>只读 / 无业务写入</Tag>
                  ) : v ? (
                    <Tag color="warning">写入 · 每次需人工确认</Tag>
                  ) : (
                    <Tag color="success">只读（服务声明）</Tag>
                  ),
              },
              {
                title: "定义",
                render: (_, t) => (
                  <Button type="link" size="small" onClick={() => setSelected(t)}>
                    查看
                  </Button>
                ),
              },
              { title: "登记时间", dataIndex: "createdAt", render: timestamp },
              {
                title: "操作",
                key: "actions",
                render: (_, t) =>
                  // An imported MCP tool is a pinned projection of a remote
                  // descriptor, so there is nothing here to edit without
                  // disagreeing with the service it came from.
                  !canManage ? (
                    <span className="muted">仅查看</span>
                  ) : t.kind === "mcp" ? (
                    <Tooltip title="MCP 工具由服务导入生成，请在 MCP 服务中重新导入">
                      <span className="muted">不可编辑</span>
                    </Tooltip>
                  ) : (
                    <Button
                      type="link"
                      size="small"
                      icon={<EditOutlined key="EditOutlined" />}
                      onClick={() => onEdit(t)}
                    >
                      编辑
                    </Button>
                  ),
              },
            ]}
          />
        </section>
      </QueryState>
      {selected && (
        <Drawer
          open
          title={selected.name}
          size="min(720px, 100vw)"
          onClose={() => setSelected(undefined)}
        >
          <div className="capability-detail">
            <div>
              <Tag>项目自定义</Tag>
              <Tag>{kindLabels[selected.kind]}</Tag>
              <Tag>v{selected.version}</Tag>
            </div>
            <p>{selected.description}</p>
            <dl>
              <dt>绑定权限</dt>
              <dd>
                {access?.permissions.includes("agent.edit")
                  ? "可在 Agent 草稿中选择绑定"
                  : "当前角色只能查看定义，不能修改 Agent 绑定"}
              </dd>
              <dt>执行条件</dt>
              <dd>通过已授权的 Agent 运行；查看定义不会直接执行工具。</dd>
              <dt>助手使用</dt>
              <dd>平台助手可读取定义，不会自动挂载执行。</dd>
              <dt>管理权限</dt>
              <dd>
                {canManage
                  ? selected.kind === "mcp"
                    ? "通过 MCP 服务重新导入更新"
                    : "可编辑此工具"
                  : "当前角色不可修改"}
              </dd>
            </dl>
            <h3>输入参数</h3>
            <pre>{JSON.stringify(selected.inputSchema, null, 2)}</pre>
            <h3>输出结构</h3>
            <pre>{JSON.stringify(selected.outputSchema, null, 2)}</pre>
          </div>
        </Drawer>
      )}
    </>
  );
}

export function ToolWorkspace(actions: { onCreate(): void; onEdit(tool: Tool): void }) {
  const [source, setSource] = useState("project");
  usePageActionTargets([
    {
      id: "tools.source",
      label: "能力目录来源",
      kind: "select",
      value: source,
      options: ["project", "system"],
      execute: (value) => {
        if (value !== "project" && value !== "system") throw new Error("目录来源无效");
        setSource(value);
      },
    },
  ]);
  return (
    <Tabs
      data-agent-target="tools.source"
      activeKey={source}
      onChange={setSource}
      destroyOnHidden
      items={[
        { key: "project", label: "项目自定义", children: <ProjectTools {...actions} /> },
        { key: "system", label: "系统内置", children: <SystemCapabilityDirectory kind="tools" /> },
      ]}
    />
  );
}
