import { CloudServerOutlined } from "@ant-design/icons";
import { Alert, Tag } from "antd";
import { timestamp } from "../../shared/api";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
export function RuntimeInfoWorkspace() {
  const runtimesQuery = useProjectQuery("runtimes", { poll: true }),
    runtimes = runtimesQuery.data ?? [];
  return (
    <QueryState label="Runtime" query={runtimesQuery}>
      <Alert
        type="info"
        showIcon
        title="当前使用预配置的托管 Runtime"
        description="Runtime 以独立服务主动连接控制面，可单独部署。客户 Runtime 的注册、凭据管理、项目绑定和私网连接器尚未开放。"
        className="form-alert"
      />
      <div className="runtime-grid">
        {runtimes.map((r) => (
          <section className="runtime-card" key={r.id}>
            <div className="runtime-title">
              <span>
                <CloudServerOutlined key="CloudServerOutlined" />
              </span>
              <div>
                <h2>{r.name}</h2>
                <code>{r.id}</code>
              </div>
              <Tag color={r.online ? "success" : "default"}>{r.online ? "在线" : "离线"}</Tag>
            </div>
            <dl>
              <div>
                <dt>部署位置</dt>
                <dd>平台托管</dd>
              </div>
              <div>
                <dt>连接方式</dt>
                <dd>主动连接控制面</dd>
              </div>
              <div>
                <dt>最近连接</dt>
                <dd>{r.lastSeenAt ? timestamp(r.lastSeenAt) : "尚未连接"}</dd>
              </div>
              <div>
                <dt>执行能力</dt>
                <dd>Agent · 工作流 · 知识处理 · Skills · HTTP / MCP 工具</dd>
              </div>
            </dl>
            <p>
              按任务的模型、工具和沙箱配置执行；在线状态仅表示连接正常，各项能力仍取决于实际依赖。
            </p>
          </section>
        ))}
      </div>
    </QueryState>
  );
}
