import { ApiOutlined, EditOutlined } from "@ant-design/icons";
import type { Model } from "@platform/sdk";
import { Button, Table, Tag, Tooltip } from "antd";
import { timestamp } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";

const kindLabels = { chat: "对话", embedding: "向量", rerank: "重排" } as const;
/** Shown next to a declared capability; `false` is stated, not implied. */
function CapabilityTags({ model }: { model: Model }) {
  const capabilities = model.capabilities;
  if (model.kind !== "chat") return <span className="muted">—</span>;
  return (
    <span className="capability-tags">
      <Tag color={capabilities?.toolUse ? "success" : "default"}>
        {capabilities?.toolUse ? "工具调用" : "无工具调用"}
      </Tag>
      <Tag color={capabilities?.vision ? "success" : "default"}>
        {capabilities?.vision ? "图片输入" : "无图片输入"}
      </Tag>
    </span>
  );
}
export function ModelWorkspace({
  onCreate,
  onEdit,
}: {
  onCreate(): void;
  onEdit(model: Model): void;
}) {
  const modelsQuery = useProjectQuery("models"),
    models = modelsQuery.data ?? [],
    // The catalogue only supplies display names; a lookup miss falls back to the
    // stored vendor id rather than hiding the row.
    vendorsQuery = useProjectQuery("modelVendors");
  const vendorLabels = Object.fromEntries(
    (vendorsQuery.data ?? []).map((preset) => [preset.vendor, preset.label]),
  );
  return (
    <QueryState label="模型服务" query={modelsQuery}>
      <section className="panel">
        <Table<Model>
          scroll={{ x: 1100 }}
          rowKey="id"
          dataSource={models}
          pagination={false}
          locale={{
            emptyText: (
              <Blank
                title="接入你的模型服务"
                description="支持 OpenAI 兼容接口，凭据加密保存在平台。"
                action={<Button onClick={() => onCreate()}>接入模型</Button>}
              />
            ),
          }}
          columns={[
            {
              title: "模型服务",
              dataIndex: "name",
              render: (_, m) => (
                <div className="cell-title">
                  <span className="table-icon">
                    <ApiOutlined key="ApiOutlined" />
                  </span>
                  <div>
                    <strong>{m.name}</strong>
                    <small>
                      {vendorLabels[m.vendor ?? "custom"] ?? m.vendor ?? "OpenAI 兼容接口"}
                    </small>
                  </div>
                </div>
              ),
            },
            {
              title: "能力",
              dataIndex: "kind",
              render: (kind: Model["kind"], m: Model) => (
                <Tag>
                  {kindLabels[kind ?? "chat"]}
                  {m.dimensions ? ` · ${m.dimensions} 维` : ""}
                </Tag>
              ),
            },
            {
              title: "模型声明",
              key: "capabilities",
              render: (_, m) => (
                <Tooltip title="由维护者声明，平台不会自动探测">
                  <span>
                    <CapabilityTags model={m} />
                  </span>
                </Tooltip>
              ),
            },
            { title: "模型 ID", dataIndex: "modelId", render: (v) => <code>{v}</code> },
            { title: "服务地址", dataIndex: "baseUrl", ellipsis: true },
            {
              title: "凭据",
              dataIndex: "hasCredential",
              render: (v) => (
                <Tag color={v ? "success" : "default"}>{v ? "已加密保存" : "未设置"}</Tag>
              ),
            },
            { title: "登记时间", dataIndex: "createdAt", render: timestamp },
            {
              title: "操作",
              key: "actions",
              render: (_, model) => (
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined key="EditOutlined" />}
                  onClick={() => onEdit(model)}
                >
                  编辑
                </Button>
              ),
            },
          ]}
        />
      </section>
    </QueryState>
  );
}
