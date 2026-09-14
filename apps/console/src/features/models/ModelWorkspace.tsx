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
  if (model.kind !== "chat") return <span className="muted">—</span>;
  const capabilities = model.capabilities;
  return (
    <span className="capability-tags">
      <span className={capabilities?.toolUse ? "capability on" : "capability off"}>工具调用</span>
      <span className={capabilities?.vision ? "capability on" : "capability off"}>图片输入</span>
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
          scroll={{ x: 920 }}
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
              width: 230,
              render: (_, m) => (
                <div className="cell-title">
                  <span className="table-icon">
                    <ApiOutlined key="ApiOutlined" />
                  </span>
                  <div className="model-name">
                    <strong>{m.name}</strong>
                    <small>
                      {vendorLabels[m.vendor ?? "custom"] ?? m.vendor ?? "OpenAI 兼容接口"}
                    </small>
                  </div>
                </div>
              ),
            },
            {
              title: "类型",
              dataIndex: "kind",
              width: 116,
              render: (kind: Model["kind"], m: Model) => (
                <Tag>
                  {kindLabels[kind ?? "chat"]}
                  {m.dimensions ? ` · ${m.dimensions} 维` : ""}
                </Tag>
              ),
            },
            {
              title: "能力声明",
              key: "capabilities",
              width: 164,
              render: (_, m) => (
                <Tooltip title="由维护者声明，平台不会自动探测">
                  <span>
                    <CapabilityTags model={m} />
                  </span>
                </Tooltip>
              ),
            },
            {
              title: "接入信息",
              key: "endpoint",
              width: 250,
              render: (_, m) => (
                <div className="model-endpoint">
                  <code>{m.modelId}</code>
                  <small>{m.baseUrl}</small>
                </div>
              ),
            },
            {
              title: "状态",
              key: "status",
              width: 128,
              render: (_, m) => (
                <div className="model-status">
                  <span className={m.hasCredential ? "model-credential ok" : "model-credential"}>
                    <i aria-hidden="true" />
                    {m.hasCredential ? "已加密保存" : "未设置"}
                  </span>
                  <small title="登记时间">{timestamp(m.createdAt)}</small>
                </div>
              ),
            },
            {
              title: "",
              key: "actions",
              width: 88,
              fixed: "right",
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
