import { ApiOutlined, KeyOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { McpDescriptor, McpDiscovery, McpServer, Tool } from "@platform/sdk";
import * as api from "@platform/sdk";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
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
import { useCallback, useEffect, useState } from "react";
import { timestamp, unwrap } from "./api";

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

export function McpWorkspace({
  projectId,
  tools,
  onChanged,
}: {
  projectId: string;
  tools: Tool[];
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [servers, setServers] = useState<McpServer[]>([]),
    [selectedId, setSelectedId] = useState<string>(),
    [create, setCreate] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    const result = await unwrap(api.listMcpServers({ path: { projectId } }));
    setServers(result);
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void unwrap(api.listMcpServers({ path: { projectId } }))
      .then((result) => {
        if (active) setServers(result);
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const selected = servers.find((s) => s.id === selectedId);
  async function save() {
    const input = await form.validateFields();
    setBusy(true);
    try {
      const server = await unwrap(api.createMcpServer({ path: { projectId }, body: input }));
      await load();
      setCreate(false);
      form.resetFields();
      setSelectedId(server.id);
      message.success("服务已登记，接下来发现并审阅能力");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
            onClick={() => void load().catch((e) => message.error(e.message))}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreate(true)}>
            登记 MCP 服务
          </Button>
        </Space>
      </section>
      {error && <Alert type="error" title={error} showIcon />}
      <section className="panel">
        <Table<McpServer>
          rowKey="id"
          loading={loading}
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
                <Tag color={s.enabled ? "green" : "default"}>{s.enabled ? "已启用" : "已停用"}</Tag>
              ),
            },
            {
              title: "工具",
              render: (_, s) => `${tools.filter((t) => t.mcp?.serverId === s.id).length} 个已导入`,
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
      <p className="form-note">
        当前开放只读查询。服务声明仅供参考，导入时需要由维护者确认业务性质。写入工具的审批链路后续接入。
      </p>
      <Modal
        title="登记 MCP 服务"
        open={create}
        onCancel={() => {
          if (!busy) {
            setCreate(false);
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
      <Drawer
        title={selected?.name ?? "MCP 服务"}
        open={!!selected}
        onClose={() => setSelectedId(undefined)}
        size="min(860px, 100vw)"
        destroyOnHidden
      >
        {selected && (
          <McpDetails
            key={selected.id}
            server={selected}
            tools={tools}
            onChanged={async () => {
              await load();
              onChanged();
            }}
          />
        )}
      </Drawer>
    </>
  );
}

function McpDetails({
  server,
  tools,
  onChanged,
}: {
  server: McpServer;
  tools: Tool[];
  onChanged: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [discoveries, setDiscoveries] = useState<McpDiscovery[]>([]),
    [viewId, setViewId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<{ descriptor: McpDescriptor; discoveryId: string }>(),
    [rotate, setRotate] = useState(false),
    [token, setToken] = useState("");
  const [form] = Form.useForm();
  const path = { projectId: server.projectId, id: server.id };
  const current = discoveries.find((d) => d.id === viewId) ?? discoveries[0];
  const pending = discoveries.some((d) => d.status === "queued" || d.status === "running");
  useEffect(() => {
    let active = true,
      inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const results = await unwrap(
          api.listMcpDiscoveries({ path: { projectId: server.projectId, id: server.id } }),
        );
        if (active) {
          setDiscoveries(results);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [server.id, server.projectId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    await action(async () => {
      const job = await unwrap(api.discoverMcpTools({ path, body: {} }));
      setDiscoveries((old) => [job, ...old.filter((d) => d.id !== job.id)]);
      setViewId(job.id);
    });
  }
  async function importTool() {
    const input = await form.validateFields();
    if (!review) return;
    await action(async () => {
      const tool = await unwrap(
        api.importMcpTool({
          path,
          body: { ...input, remoteName: review.descriptor.name, discoveryId: review.discoveryId },
        }),
      );
      await onChanged();
      setReview(undefined);
      form.resetFields();
      message.success(`已导入 ${tool.name}，可在 Agent 配置中绑定`);
    });
  }
  return (
    <div className="mcp-details">
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
        <Button icon={<KeyOutlined />} onClick={() => setRotate(true)}>
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
            action(async () => {
              await unwrap(api.updateMcpServer({ path, body: { enabled: !server.enabled } }));
              await onChanged();
            })
          }
        >
          <Button danger={server.enabled} disabled={busy}>
            {server.enabled ? "停用服务" : "启用服务"}
          </Button>
        </Popconfirm>
      </Space>
      {error && <Alert type="error" title={error} showIcon />}
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
                    <Tag>
                      {d.annotations?.readOnlyHint === true
                        ? "自称只读"
                        : d.annotations?.readOnlyHint === false
                          ? "含写入"
                          : "未声明"}
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
                        });
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
        </Form>
        <Typography.Text type="secondary">
          服务的只读声明不能替代核实。当前不导入需要业务写入审批的能力。
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
          action(async () => {
            await unwrap(api.updateMcpServer({ path, body: { bearerToken: token } }));
            await onChanged();
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
