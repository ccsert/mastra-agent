import { CloudServerOutlined } from "@ant-design/icons";
import { Tag } from "antd";
import { timestamp } from "../../shared/api";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
export function RuntimeInfoWorkspace() {
  const runtimesQuery = useProjectQuery("runtimes", { poll: true }),
    runtimes = runtimesQuery.data ?? [];
  return (
    <QueryState label="Runtime" query={runtimesQuery}>
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
                <dd>Agent · 授权只读工具</dd>
              </div>
            </dl>
            <p>Runtime 独立执行任务，并回传消息与工具事件。</p>
          </section>
        ))}
      </div>
    </QueryState>
  );
}
