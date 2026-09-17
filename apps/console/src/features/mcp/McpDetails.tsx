import { KeyOutlined, ReloadOutlined } from "@ant-design/icons";
import type { McpDescriptor, McpDiscovery, McpServer, Tool } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { timestamp, unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { PageMore, pageItems, prependPage } from "../../shared/data/pages";
import { QueryState } from "../../shared/data/QueryState";
import { useOperation } from "../../shared/useOperation";
import { mcpQueries } from "./queries";

const states: Record<McpDiscovery["status"], string> = {
  queued: "等待 Runtime",
  running: "发现中",
  succeeded: "发现完成",
  failed: "发现失败",
  cancelled: "已取消",
};
const errors: Record<string, string> = {
  MCP_CONNECTION_FAILED: "连接失败，请检查服务地址、凭据和 Runtime 网络。",
  MCP_DISCOVERY_INVALID: "能力目录无效，可能存在重复名称或分页错误。",
  MCP_LIMIT: "能力目录超过当前大小或分页预算。",
  MCP_DISABLED: "服务已停用。",
  TIMEOUT: "发现超时，请检查服务后重新发现。",
  RUNTIME_UNAVAILABLE: "Runtime 未领取任务，请检查运行服务。",
};

export function McpDetails({ server, tools }: { server: McpServer; tools: Tool[] }) {
  const { message } = App.useApp(),
    refresh = useProjectRefresh(),
    client = useQueryClient();
  const discoveriesQuery = useInfiniteQuery(mcpQueries.discoveries(server.projectId, server.id)),
    discoveries = pageItems(discoveriesQuery.data);

  const [viewId, setViewId] = useState<string>(),
    [review, setReview] = useState<{ descriptor: McpDescriptor; discoveryId: string }>(),
    [rotate, setRotate] = useState(false),
    [token, setToken] = useState("");
  const [form] = Form.useForm();
  const path = { projectId: server.projectId, id: server.id };
  const current = discoveries.find((d) => d.id === viewId) ?? discoveries[0];
  const pending = discoveries.some((d) => d.status === "queued" || d.status === "running");
  const { busy, error, setError, run: action } = useOperation();
  async function discover() {
    await action(async (signal) => {
      const job = await unwrap(api.discoverMcpTools({ path, body: {}, signal }), signal);
      client.setQueryData(mcpQueries.discoveries(server.projectId, server.id).queryKey, (old) =>
        prependPage(old, job),
      );
      void refresh("mcpServers");
      setViewId(job.id);
    });
  }
  async function importTool() {
    const input = await form.validateFields();
    if (!review) return;
    await action(async (signal) => {
      const tool = await unwrap(
        api.importMcpTool({
          path,
          signal,
          body: { ...input, remoteName: review.descriptor.name, discoveryId: review.discoveryId },
        }),
        signal,
      );
      await refresh("mcpServers", "tools", "workflowCatalog");
      signal.throwIfAborted();
      setReview(undefined);
      form.resetFields();
      message.success(`已导入 ${tool.name}，可在 Agent 配置中绑定`);
    });
  }
  return (
    <div className="mcp-details">
      {error && !review && !rotate && <Alert type="error" title={error} />}
      <div className="mcp-service-meta">
        <Typography.Text copyable>{server.url}</Typography.Text>
        <Space wrap>
          <Tag>Streamable HTTP</Tag>
          <Tag color={server.enabled ? "green" : "default"}>
            {server.enabled ? "已启用" : "已停用"}
          </Tag>
        </Space>
      </div>
      <Space wrap>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          loading={busy || pending}
          disabled={!server.enabled}
          onClick={() => void discover()}
        >
          发现能力
        </Button>
        <Button
          icon={<KeyOutlined />}
          onClick={() => {
            setError("");
            setRotate(true);
          }}
        >
          更新凭据
        </Button>
        <Popconfirm
          title={server.enabled ? "停用此 MCP 服务？" : "启用此 MCP 服务？"}
          description={
            server.enabled
              ? "绑定此服务的 Agent 后续调用将被拒绝。"
              : "已绑定的 Agent 将恢复使用此服务。"
          }
          okText="确认"
          cancelText="取消"
          onConfirm={() =>
            action(async (signal) => {
              await unwrap(
                api.updateMcpServer({ path, body: { enabled: !server.enabled }, signal }),
                signal,
              );
              await refresh("mcpServers", "tools", "workflowCatalog");
              signal.throwIfAborted();
            })
          }
        >
          <Button danger={server.enabled} disabled={busy}>
            {server.enabled ? "停用服务" : "启用服务"}
          </Button>
        </Popconfirm>
      </Space>
      <QueryState label="能力发现记录" query={discoveriesQuery}>
        {!discoveries.length ? (
          <Empty description="点击「发现能力」读取远端工具目录。发现过程不会执行业务工具。" />
        ) : (
          <>
            <Form layout="vertical">
              <Form.Item label="发现记录">
                <Select
                  aria-label="发现记录"
                  value={current?.id}
                  onChange={(id) => {
                    setViewId(id);
                    setReview(undefined);
                  }}
                  options={discoveries.map((d) => ({
                    value: d.id,
                    label: `${timestamp(d.createdAt)} · ${states[d.status]} · ${d.tools.length} 个能力`,
                  }))}
                />
              </Form.Item>
            </Form>
            {current && (
              <Alert
                type={current.status === "failed" ? "error" : "info"}
                showIcon
                title={states[current.status]}
                description={
                  current.errorCode
                    ? (errors[current.errorCode] ?? current.errorCode)
                    : current.status === "succeeded"
                      ? "查看输入与输出，确认只读后导入。重新发现不会替换已导入的工具。"
                      : "Runtime 正在连接服务并读取完整能力目录。"
                }
              />
            )}
            {current?.status === "succeeded" && (
              <Table<McpDescriptor>
                rowKey="name"
                dataSource={current.tools}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                scroll={{ x: 580 }}
                columns={[
                  {
                    title: "远端能力",
                    render: (_, d) => (
                      <div className="cell-title">
                        <div>
                          <strong>{d.title ?? d.name}</strong>
                          <small>{d.description}</small>
                          <code>{d.name}</code>
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: "服务声明",
                    width: 115,
                    render: (_, d) => (
                      <Tag
                        color={
                          d.annotations?.readOnlyHint === true
                            ? undefined
                            : d.annotations?.readOnlyHint === false
                              ? "warning"
                              : "default"
                        }
                      >
                        {d.annotations?.readOnlyHint === true
                          ? "自称只读"
                          : d.annotations?.readOnlyHint === false
                            ? "含写入 · 需确认"
                            : "未声明 · 视为写入"}
                      </Tag>
                    ),
                  },
                  {
                    title: "操作",
                    width: 115,
                    render: (_, d) => (
                      <Button
                        type="link"
                        disabled={!server.enabled}
                        onClick={() => {
                          form.setFieldsValue({
                            name: `mcp_${d.name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(
                              0,
                              50,
                            ),
                            confirmedReadOnly: false,
                            acceptWriteConfirmations: false,
                          });
                          setError("");
                          setReview({ descriptor: d, discoveryId: current.id });
                        }}
                      >
                        审阅与导入
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
        <PageMore query={discoveriesQuery} count={discoveries.length} label="发现记录" />
      </QueryState>
      <h3>已导入工具</h3>
      {tools
        .filter((t) => t.mcp?.serverId === server.id)
        .map((tool) => (
          <div className="mcp-imported" key={tool.id}>
            <strong>{tool.name}</strong>
            <Typography.Text type="secondary">
              {tool.mcp?.descriptor.name} · 快照 {tool.mcp?.contractDigest.slice(0, 12)}
            </Typography.Text>
          </div>
        ))}
      {!tools.some((t) => t.mcp?.serverId === server.id) && (
        <Typography.Text type="secondary">尚未导入。导入后仍需绑定并发布 Agent。</Typography.Text>
      )}
      <Modal
        title={`审阅能力：${review?.descriptor.name ?? ""}`}
        open={!!review}
        onCancel={() => {
          if (!busy) setReview(undefined);
        }}
        onOk={() => void importTool().catch(() => {})}
        confirmLoading={busy}
        okText="导入工具"
        cancelText="取消"
        width={720}
        destroyOnHidden
      >
        {review && error && <Alert type="error" title={error} />}
        <p>{review?.descriptor.description}</p>
        <div className="mcp-schema">
          <h4>输入 Schema</h4>
          <pre>{JSON.stringify(review?.descriptor.inputSchema, null, 2)}</pre>
          <h4>输出 Schema</h4>
          <pre>
            {review?.descriptor.outputSchema
              ? JSON.stringify(review.descriptor.outputSchema, null, 2)
              : "未提供；当前只接收文本结果。"}
          </pre>
        </div>
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="平台调用名称"
            rules={[
              { required: true },
              {
                pattern: /^[a-z][a-z0-9_]{1,49}$/,
                message: "使用 2–50 位小写字母、数字和下划线，以字母开头",
              },
            ]}
          >
            <Input maxLength={50} />
          </Form.Item>
          {review?.descriptor.annotations?.readOnlyHint === true ? (
            <Form.Item
              name="confirmedReadOnly"
              valuePropName="checked"
              rules={[
                {
                  validator: (_, value) =>
                    value === true
                      ? Promise.resolve()
                      : Promise.reject(new Error("请确认该工具的只读性质")),
                },
              ]}
            >
              <Checkbox>我已核实该能力只查询数据，不修改业务记录</Checkbox>
            </Form.Item>
          ) : (
            <Form.Item
              name="acceptWriteConfirmations"
              valuePropName="checked"
              rules={[
                {
                  validator: (_, value) =>
                    value === true
                      ? Promise.resolve()
                      : Promise.reject(new Error("请确认接受每次调用的人工确认")),
                },
              ]}
            >
              <Checkbox>该工具未声明只读。我接受它每次调用都需要人工确认后才执行</Checkbox>
            </Form.Item>
          )}
        </Form>
        <Typography.Text type="secondary">
          {review?.descriptor.annotations?.readOnlyHint === true
            ? "服务的只读声明不能替代核实。"
            : "未证实只读的工具不会被静默放行：确认后由平台在每次调用前暂停并等待人工决定，未答复则不会执行。"}
        </Typography.Text>
      </Modal>
      <Modal
        title="更新 MCP 凭据"
        open={rotate}
        onCancel={() => {
          if (!busy) {
            setRotate(false);
            setToken("");
          }
        }}
        onOk={() =>
          action(async (signal) => {
            await unwrap(
              api.updateMcpServer({ path, body: { bearerToken: token }, signal }),
              signal,
            );
            await refresh("mcpServers", "tools", "workflowCatalog");
            signal.throwIfAborted();
            setToken("");
            setRotate(false);
            message.success("凭据已更新");
          })
        }
        confirmLoading={busy}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        {rotate && error && <Alert type="error" title={error} />}
        <Form layout="vertical">
          <Form.Item
            label="新的 Bearer Token"
            htmlFor="mcp-token"
            extra="留空保存会移除现有凭据。新的调用使用更新后的凭据。"
          >
            <Input.Password
              id="mcp-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              maxLength={4096}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
