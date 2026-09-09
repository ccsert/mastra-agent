import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { useProjectQuery } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import type { Page } from "../../shared/navigation";
import { type AgentActions, AgentCollection } from "../agents/index";
export function Overview({
  navigate,
  onEdit,
  onConversation,
}: AgentActions & { navigate(page: Page): void }) {
  const agentsQuery = useProjectQuery("agents"),
    modelsQuery = useProjectQuery("models"),
    toolsQuery = useProjectQuery("tools"),
    runsQuery = useProjectQuery("runs", { poll: true });
  const agents = agentsQuery.data ?? [],
    models = modelsQuery.data ?? [],
    runs = runsQuery.data ?? [];
  return (
    <>
      <div className="metrics">
        {[
          [
            <RobotOutlined key="RobotOutlined" />,
            "Agent",
            agentsQuery.data?.length ?? "—",
            agentsQuery.data
              ? `${agents.filter((a) => a.publishedReleaseId).length} 个已发布`
              : "等待数据",
          ],
          [
            <ApiOutlined key="ApiOutlined" />,
            "模型服务",
            modelsQuery.data?.length ?? "—",
            "已登记配置",
          ],
          [
            <ToolOutlined key="ToolOutlined" />,
            "工具",
            toolsQuery.data?.length ?? "—",
            "只读与确定性能力",
          ],
          [
            <DeploymentUnitOutlined key="DeploymentUnitOutlined" />,
            "最近运行",
            runsQuery.data?.length ?? "—",
            runsQuery.data
              ? `${runs.filter((r) => r.status === "succeeded").length} 次成功`
              : "等待数据",
          ],
        ].map(([icon, label, value, note]) => (
          <section className="metric" key={String(label)}>
            <span>
              {icon} {label}
            </span>
            <strong>{value}</strong>
            <small>{note}</small>
          </section>
        ))}
      </div>
      <QueryState label="模型服务" query={modelsQuery}>
        {null}
      </QueryState>
      <QueryState label="工具" query={toolsQuery}>
        {null}
      </QueryState>
      <QueryState label="运行记录" query={runsQuery}>
        {null}
      </QueryState>
      <section className="onboarding">
        <div>
          <span className="eyebrow">从配置到调用</span>
          <h2>跑通团队的第一条 Agent 链路</h2>
          <p>模型提供推理能力，工具连接业务，发布版本供平台与应用调用。</p>
        </div>
        <div className="onboarding-steps">
          {[
            {
              done: models.length > 0,
              label: "接入模型",
              detail: "配置你自己的模型服务",
              action: () => navigate("models"),
            },
            {
              done: agents.length > 0,
              label: "创建 Agent",
              detail: "定义角色与授权工具",
              action: () => navigate("agents"),
            },
            {
              done: runs.some((r) => r.status === "succeeded"),
              label: "运行与接入",
              detail: "对话验证后接入业务系统",
              action: () => navigate("applications"),
            },
          ].map((step, i) => (
            <button type="button" key={step.label} onClick={step.action}>
              <span className={step.done ? "step-number done" : "step-number"}>
                {step.done ? <CheckCircleOutlined key="CheckCircleOutlined" /> : i + 1}
              </span>
              <span>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
              <ArrowRightOutlined key="ArrowRightOutlined" />
            </button>
          ))}
        </div>
      </section>
      <div className="section-heading">
        <h2>项目中的 Agents</h2>
        <Button type="link" onClick={() => navigate("agents")}>
          查看全部 <ArrowRightOutlined key="ArrowRightOutlined" />
        </Button>
      </div>
      <AgentCollection limit={3} onEdit={onEdit} onConversation={onConversation} />
      <div className="scope-note">
        <ExperimentOutlined key="ExperimentOutlined" />
        <p>
          当前已开放 Agent 对话、工具调用、知识库检索、标准 Skills 和 AI
          工作流。嵌入组件将继续接入这套平台。
        </p>
      </div>
    </>
  );
}
