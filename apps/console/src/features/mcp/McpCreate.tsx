import type { McpServer } from "@platform/sdk";
import * as api from "@platform/sdk";
import { App, Form, Input, Modal } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { useLifetime } from "../../shared/useLifetime";
export function McpCreate({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose(): void;
  onCreated(server: McpServer): void;
}) {
  const { message } = App.useApp(),
    lifetime = useLifetime(),
    refresh = useProjectRefresh();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  async function save() {
    const signal = lifetime(),
      input = await form.validateFields();
    signal.throwIfAborted();
    setBusy(true);
    try {
      const server = await unwrap(
        api.createMcpServer({ path: { projectId }, body: input, signal }),
        signal,
      );
      void refresh("mcpServers");
      onCreated(server);
      message.success("服务已登记，接下来发现并审阅能力");
    } catch (error) {
      if (!signal.aborted) message.error(error instanceof Error ? error.message : "登记失败");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <Modal
      title="登记 MCP 服务"
      open
      onCancel={() => {
        if (!busy) {
          onClose();
          form.resetFields();
        }
      }}
      onOk={() => void save().catch(() => {})}
      okText="登记"
      cancelText="取消"
      confirmLoading={busy}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ bearerToken: "" }}>
        <Form.Item name="name" label="服务名称" rules={[{ required: true }]}>
          <Input placeholder="例如：订单服务" maxLength={80} />
        </Form.Item>
        <Form.Item
          name="url"
          label="服务地址"
          rules={[{ required: true }, { type: "url" }]}
          extra="使用 Streamable HTTP MCP 地址，由平台 Runtime 连接。"
        >
          <Input placeholder="https://orders.example.com/mcp" maxLength={500} />
        </Form.Item>
        <Form.Item
          name="bearerToken"
          label="Bearer Token"
          extra="使用该业务服务的独立凭据，加密保存。"
        >
          <Input.Password autoComplete="new-password" maxLength={4096} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
