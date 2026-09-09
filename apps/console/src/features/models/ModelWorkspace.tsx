import { ApiOutlined } from "@ant-design/icons";
import type { Model } from "@platform/sdk";
import { Button, Table, Tag } from "antd";
import { timestamp } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
export function ModelWorkspace({ onCreate }: { onCreate(): void }) {
  const modelsQuery = useProjectQuery("models"),
    models = modelsQuery.data ?? [];
  return (
    <QueryState label="模型服务" query={modelsQuery}>
      <section className="panel">
        <Table<Model>
          scroll={{ x: 850 }}
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
                    <small>OpenAI 兼容接口</small>
                  </div>
                </div>
              ),
            },
            {
              title: "能力",
              dataIndex: "kind",
              render: (kind: Model["kind"], m: Model) => (
                <Tag>
                  {{ chat: "对话", embedding: "向量", rerank: "重排" }[kind ?? "chat"]}
                  {m.dimensions ? ` · ${m.dimensions} 维` : ""}
                </Tag>
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
          ]}
        />
      </section>
    </QueryState>
  );
}
