import {
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import type { Principal, RuntimeInfo } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, App as AntApp, Button, Input, Modal, Popconfirm, Tag } from "antd";
import { useState } from "react";
import { useProjectAccess } from "../../shared/access";
import { timestamp, unwrap } from "../../shared/api";
import { useProjectQuery, useProjectRefresh } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";

type Issued = { id: string; name: string; token: string };

function CopyLine({ label, value }: { label: string; value: string }) {
  const { message } = AntApp.useApp();
  return (
    <div className="runtime-copy-line">
      <code>{value}</code>
      <Button
        size="small"
        type="text"
        icon={<CopyOutlined />}
        aria-label={`复制 ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            void message.success(`已复制 ${label}`);
          } catch {
            void message.error("复制失败，请手动选择复制");
          }
        }}
      />
    </div>
  );
}

export function RuntimeInfoWorkspace({ user }: { user: Principal }) {
  const refresh = useProjectRefresh();
  const { message } = AntApp.useApp();
  const access = useProjectAccess();
  const admin = ["owner", "admin"].includes(String(access?.tenantRole ?? user.tenantRole ?? ""));
  const runtimesQuery = useProjectQuery("runtimes", { poll: true }),
    runtimes = runtimesQuery.data ?? [];
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<Issued>();
  const [renaming, setRenaming] = useState<{ runtime: RuntimeInfo; value: string }>();

  async function register() {
    try {
      const created = await unwrap(
        api.registerRuntime({ body: { name: name.trim() || "客户 Runtime" } }),
      );
      setRegistering(false);
      setIssued(created);
      setName("");
      await refresh("runtimes");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "注册失败");
    }
  }
  async function update(runtime: RuntimeInfo, body: { name?: string; enabled?: boolean }) {
    try {
      await unwrap(api.updateRuntime({ path: { id: runtime.id }, body }));
      await refresh("runtimes");
      return true;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败");
      return false;
    }
  }
  async function remove(runtime: RuntimeInfo) {
    try {
      await unwrap(api.deleteRuntime({ path: { id: runtime.id } }));
      await refresh("runtimes");
      void message.success("Runtime 已删除");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  return (
    <QueryState label="Runtime" query={runtimesQuery}>
      <Alert
        type="info"
        showIcon
        title="Runtime 以独立服务主动连接控制面，可单独部署"
        description="注册后获得部署凭据；停用会立即拒绝该 Runtime 认领任务。任务执行目前仍由托管 Runtime 承担，多 Runtime 任务分配将在后续交付。"
        className="form-alert"
      />
      {admin && (
        <div className="runtime-toolbar">
          <Button
            type="primary"
            icon={<PlusOutlined />}
            aria-label="注册 Runtime"
            onClick={() => {
              setName("");
              setRegistering(true);
            }}
          >
            注册 Runtime
          </Button>
        </div>
      )}
      <div className="runtime-grid">
        {runtimes.map((r) => (
          <section className="runtime-card" key={r.id}>
            <div className="runtime-title">
              <span>
                <CloudServerOutlined />
              </span>
              <div>
                <h2>{r.name}</h2>
                <code>{r.id}</code>
              </div>
              <Tag color={!r.enabled ? "default" : r.online ? "success" : "warning"}>
                {!r.enabled ? "已停用" : r.online ? "在线" : "离线"}
              </Tag>
            </div>
            <dl>
              <div>
                <dt>部署位置</dt>
                <dd>{r.builtIn ? "平台托管" : "已注册 · 独立部署"}</dd>
              </div>
              <div>
                <dt>连接方式</dt>
                <dd>主动连接控制面</dd>
              </div>
              <div>
                <dt>最近心跳</dt>
                <dd>{r.lastSeenAt ? timestamp(r.lastSeenAt) : "尚未连接"}</dd>
              </div>
            </dl>
            {admin && (
              <div className="runtime-actions">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setRenaming({ runtime: r, value: r.name })}
                >
                  改名
                </Button>
                <Button
                  size="small"
                  danger={r.enabled}
                  onClick={() => void update(r, { enabled: !r.enabled })}
                >
                  {r.enabled ? "停用" : "启用"}
                </Button>
                {!r.builtIn && (
                  <Popconfirm
                    title="删除此 Runtime？"
                    description="删除后其部署凭据立即失效。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(r)}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除 ${r.name}`}
                    />
                  </Popconfirm>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
      <Modal
        title="注册 Runtime"
        open={registering}
        onCancel={() => setRegistering(false)}
        onOk={() => void register()}
        okText="注册并签发凭据"
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Input
          aria-label="Runtime 名称"
          placeholder="例如：客户 A 内网 Runtime"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="form-note">注册后获得部署凭据，可随时停用或删除。</p>
      </Modal>
      <Modal
        title="Runtime 已注册"
        open={!!issued}
        onCancel={() => setIssued(undefined)}
        footer={
          <Button type="primary" onClick={() => setIssued(undefined)}>
            我已保存凭据
          </Button>
        }
      >
        {issued && (
          <div className="runtime-issued">
            <Alert type="warning" showIcon title="令牌仅显示这一次，请立即保存" />
            <dl>
              <dt>RUNTIME_ID</dt>
              <dd>
                <CopyLine label="RUNTIME_ID" value={issued.id} />
              </dd>
              <dt>RUNTIME_TOKEN</dt>
              <dd>
                <CopyLine label="RUNTIME_TOKEN" value={issued.token} />
              </dd>
            </dl>
            <p className="form-note">
              在 Runtime 部署配置中设置以上凭据与控制面地址，启动后即出现在上方列表。
            </p>
          </div>
        )}
      </Modal>
      <Modal
        title="重命名 Runtime"
        open={!!renaming}
        onCancel={() => setRenaming(undefined)}
        onOk={() => {
          if (renaming) {
            const next = renaming.value.trim();
            if (next && next !== renaming.runtime.name)
              void update(renaming.runtime, { name: next }).then((ok) => {
                if (ok) void message.success("已重命名");
              });
          }
          setRenaming(undefined);
        }}
        okText="保存"
      >
        {renaming && (
          <Input
            aria-label="Runtime 名称"
            value={renaming.value}
            maxLength={60}
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
          />
        )}
      </Modal>
    </QueryState>
  );
}
