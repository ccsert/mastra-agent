import { ApiOutlined, CodeOutlined, PlusOutlined } from "@ant-design/icons";
import type { Application } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, App as AntApp, Button, Input, Modal, Table, Tag } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { useLifetime } from "../../shared/useLifetime";
import { ApplicationEditor } from "./ApplicationEditor";

export function ApplicationsWorkspace({ projectId }: { projectId: string }) {
  const { message } = AntApp.useApp(),
    lifetime = useLifetime();
  const query = useProjectQuery("applications"),
    applications = query.data ?? [],
    refresh = useProjectRefresh();
  const [creating, setCreating] = useState(false),
    [revoking, setRevoking] = useState("");
  const [credential, setCredential] = useState<(Application & { secretKey: string }) | null>(null);
  async function revoke(application: Application) {
    const signal = lifetime();
    setRevoking(application.id);
    try {
      await unwrap(
        api.revokeApplication({ path: { projectId, id: application.id }, body: {}, signal }),
      );
      if (!signal.aborted) await refresh("applications");
    } catch (error) {
      if (!signal.aborted) void message.error(error instanceof Error ? error.message : "撤销失败");
    } finally {
      if (!signal.aborted) setRevoking("");
    }
  }
  return (
    <>
      <section className="integration-banner">
        <div className="integration-icon">
          <CodeOutlined key="CodeOutlined" />
        </div>
        <div>
          <h2>把 Agent 接入业务后端</h2>
          <p>创建项目范围的 AppID 与 AK/SK，使用生成的 TypeScript SDK 调用。凭据仅保存在服务端。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          创建应用
        </Button>
        <Button href="/openapi.json" target="_blank" icon={<ApiOutlined key="ApiOutlined" />}>
          OpenAPI 定义
        </Button>
      </section>
      <QueryState label="应用" query={query}>
        <section className="panel">
          <Table<Application>
            rowKey="id"
            dataSource={applications}
            pagination={false}
            locale={{
              emptyText: (
                <Blank
                  title="创建应用凭据"
                  description="应用与平台用户的会话默认隔离，应用只能使用当前项目中已发布的 Agent。"
                />
              ),
            }}
            columns={[
              { title: "应用名称", dataIndex: "name" },
              { title: "AppID", dataIndex: "id", render: (v) => <code>{v}</code> },
              {
                title: "状态",
                dataIndex: "active",
                render: (v) => <Tag color={v ? "success" : "default"}>{v ? "有效" : "已撤销"}</Tag>,
              },
              {
                title: "操作",
                render: (_, a) => (
                  <Button
                    danger
                    type="text"
                    disabled={!a.active || !!revoking}
                    loading={revoking === a.id}
                    onClick={() => void revoke(a)}
                  >
                    撤销凭据
                  </Button>
                ),
              },
            ]}
          />
        </section>
      </QueryState>
      <section className="code-panel">
        <div>
          <strong>生成 SDK 调用示例</strong>
          <Tag>TypeScript · 服务端</Tag>
        </div>
        <pre>{`import { createClient } from '@platform/sdk/client';\nimport { applicationSigner } from '@platform/sdk/auth';\nimport { createConversation, createRun, getRun } from '@platform/sdk';\n\nconst client = createClient({ baseUrl: process.env.PLATFORM_URL });\nclient.interceptors.request.use(applicationSigner({\n  appId: process.env.APP_ID,\n  accessKey: process.env.ACCESS_KEY,\n  secretKey: process.env.SECRET_KEY,\n}));\nconst path = { projectId: '${projectId}' };\nconst { data: conversation } = await createConversation({\n  client, path, body: { agentId: '已发布的 Agent ID' },\n});\nconst { data: run } = await createRun({\n  client, path, body: { conversationId: conversation.id,\n    input: '请处理这项任务', requestId: crypto.randomUUID() },\n});\n// 使用 getRun 查询状态；使用 listRunEvents 读取执行事件。`}</pre>
      </section>

      {creating && (
        <ApplicationEditor
          projectId={projectId}
          onClose={() => setCreating(false)}
          onSaved={() => void refresh("applications")}
          onCredential={setCredential}
        />
      )}
      <Modal
        title="保存应用凭据"
        open={!!credential}
        onCancel={() => setCredential(null)}
        footer={
          <Button type="primary" onClick={() => setCredential(null)}>
            我已保存
          </Button>
        }
        destroyOnHidden
      >
        {credential && (
          <>
            <Alert type="warning" title="SK 只显示这一次。关闭后无法再次查看，请保存在业务后端。" />
            <div className="credential-fields">
              <label htmlFor="app-id">
                AppID
                <Input id="app-id" readOnly value={credential.id} />
              </label>
              <label htmlFor="access-key">
                Access Key
                <Input id="access-key" readOnly value={credential.accessKey} />
              </label>
              <label htmlFor="secret-key">
                Secret Key
                <Input.Password id="secret-key" readOnly value={credential.secretKey} />
              </label>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
