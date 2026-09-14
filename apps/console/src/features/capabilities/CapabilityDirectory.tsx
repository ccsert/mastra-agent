import {
  BookOutlined,
  CheckCircleOutlined,
  LockOutlined,
  SafetyOutlined,
  SearchOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { AssistantCapabilities, AssistantCapabilityOperation } from "@platform/sdk";
import * as api from "@platform/sdk";
import { useQuery } from "@tanstack/react-query";
import { Button, Drawer, Input, Tabs, Tag } from "antd";
import { useState } from "react";
import { timestamp, unwrap } from "../../shared/api";
import { Blank } from "../../shared/Blank";
import { useProjectId } from "../../shared/data/ProjectData";
import { QueryState } from "../../shared/data/QueryState";
import { usePageActionReadiness, usePageActionTargets } from "../../shared/PageActions";

type Kind = "skills" | "tools";
type Capability = AssistantCapabilities[Kind][number];
const groups: Record<string, string> = {
  agent: "智能体",
  skill: "Skills",
  knowledge: "知识库",
  document: "文档",
  workflow: "工作流",
  model: "模型",
  tool: "工具",
  mcp: "MCP",
  project: "项目",
  member: "成员",
  access: "权限",
  audit: "审计",
  application: "应用",
};
export const permissionLabels: Record<string, string> = {
  "project.read": "查看项目",
  "project.manage": "管理项目",
  "resource.read": "查看资源",
  "resource.edit": "编辑资源",
  "resource.manage": "管理资源",
  "agent.edit": "编辑智能体",
  "agent.publish": "发布智能体",
  "agent.run": "运行智能体",
};
function useCapabilities(conversationId?: string, running = false) {
  const projectId = useProjectId();
  return useQuery({
    queryKey: ["project", projectId, "assistantCapabilities", conversationId ?? "catalog"],
    queryFn: ({ signal }) =>
      unwrap(
        api.getAssistantCapabilities({ path: { projectId }, query: { conversationId }, signal }),
      ),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: running ? 5000 : false,
  });
}
function OperationRow({ operation }: { operation: AssistantCapabilityOperation }) {
  const projectId = useProjectId(),
    [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["project", projectId, "assistantOperation", operation.id],
    queryFn: ({ signal }) =>
      unwrap(api.getAssistantOperation({ path: { projectId, operationId: operation.id }, signal })),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  return (
    <details className="capability-operation" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="capability-operation-name">
          <strong>{operation.label}</strong>
          <code>{operation.id}</code>
        </span>
        <span>{groups[operation.group] ?? operation.group}</span>
        <Tag
          color={
            operation.available ? (operation.mode === "read" ? "success" : "processing") : "default"
          }
        >
          {!operation.available ? "权限不足" : operation.mode === "read" ? "可查询" : "可准备变更"}
        </Tag>
      </summary>
      <div className="capability-operation-body">
        <p>
          需要：{permissionLabels[operation.permission]}
          {operation.tenantAdmin ? " · 团队管理员" : ""}。
          {operation.mode === "write" ? "应用变更前需要你审阅。" : "查询或预览不会修改业务资源。"}
          {operation.risk === "publish"
            ? "发布需独立审阅。"
            : operation.risk === "access"
              ? "授权需独立审阅。"
              : ""}
        </p>
        {open && (
          <QueryState label="操作参数" query={detail}>
            {detail.data && <pre>{JSON.stringify(detail.data.inputSchema, null, 2)}</pre>}
          </QueryState>
        )}
      </div>
    </details>
  );
}
function Operations({
  data,
  interactive = false,
}: {
  data: AssistantCapabilities;
  interactive?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [availableOnly, setAvailableOnly] = useState(false);
  usePageActionTargets(
    interactive
      ? [
          {
            id: "capability.operations.search",
            label: "搜索系统操作",
            kind: "fill",
            value: search,
            execute: (value) => setSearch(value ?? ""),
          },
          {
            id: "capability.operations.available",
            label: "仅看可用操作",
            kind: "select",
            value: String(availableOnly),
            options: ["true", "false"],
            execute: (value) => setAvailableOnly(value === "true"),
          },
        ]
      : [],
  );
  const filtered = data.operations.filter(
    (o) =>
      (!availableOnly || o.available) &&
      `${o.id} ${o.label} ${groups[o.group] ?? o.group}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <section className="capability-operations" aria-label="系统操作目录">
      <div className="capability-section-heading">
        <div>
          <h3>具体能做什么</h3>
          <p>
            工具入口调用以下操作。当前可用 {data.operations.filter((o) => o.available).length} /{" "}
            {data.operations.length} 项。
          </p>
        </div>
      </div>
      <div className="capability-filters">
        <Input
          data-agent-target="capability.operations.search"
          aria-label="搜索系统操作"
          placeholder="搜索创建、知识库、权限…"
          prefix={<SearchOutlined />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Button
          data-agent-target="capability.operations.available"
          aria-pressed={availableOnly}
          type={availableOnly ? "primary" : "default"}
          onClick={() => setAvailableOnly((v) => !v)}
        >
          仅看可用
        </Button>
      </div>
      {filtered.map((o) => (
        <OperationRow key={o.id} operation={o} />
      ))}
      {!filtered.length && (
        <Blank title="没有匹配的操作" description="试试其他关键词，或取消仅看可用。" />
      )}
    </section>
  );
}
function Cards({
  data,
  kind,
  interactive = false,
}: {
  data: AssistantCapabilities;
  kind: Kind;
  interactive?: boolean;
}) {
  const [selected, setSelected] = useState<Capability>(),
    [search, setSearch] = useState("");
  usePageActionTargets(
    interactive
      ? [
          {
            id: "capability.search",
            label: kind === "skills" ? "搜索内置 Skills" : "搜索系统工具",
            kind: "fill",
            value: search,
            execute: (value) => setSearch(value ?? ""),
          },
        ]
      : [],
  );
  const items = data[kind].filter((s) =>
    `${s.name} ${s.id} ${s.description}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const detail = data[kind].find((s) => s.id === selected?.id);
  return (
    <>
      <div className="capability-section-heading">
        <div>
          <h3>{kind === "skills" ? "平台助手的内置 Skills" : "平台助手的系统工具"}</h3>
          <p>
            {kind === "skills"
              ? "根据任务按需读取指导，帮助助手理解平台和组织工作。"
              : "这些入口连接系统操作，每次调用都校验当前用户权限。"}
          </p>
        </div>
        <Tag icon={<LockOutlined />}>系统维护 · 只读</Tag>
      </div>
      <Input
        data-agent-target="capability.search"
        className="capability-search"
        aria-label={kind === "skills" ? "搜索内置 Skills" : "搜索系统工具"}
        placeholder="按名称或用途查找"
        prefix={<SearchOutlined />}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        allowClear
      />
      <div className="capability-grid">
        {items.map((item) => (
          <button
            type="button"
            className="capability-card"
            key={item.id}
            onClick={() => setSelected(item)}
          >
            <div className="capability-card-top">
              <span className="capability-icon">
                {kind === "skills" ? <BookOutlined /> : <ToolOutlined />}
              </span>
              <Tag>系统内置</Tag>
              <small>v{item.version}</small>
            </div>
            <h4>{item.name}</h4>
            <code>{item.id}</code>
            <p>{"summary" in item ? item.summary : item.description}</p>
            <footer>
              {item.usage.count ? (
                <span className="capability-used">
                  <CheckCircleOutlined /> 本任务已{kind === "skills" ? "读取" : "调用"}{" "}
                  {item.usage.count} 次
                </span>
              ) : (
                <span>
                  {"available" in item && !item.available
                    ? "当前权限不可用"
                    : kind === "skills"
                      ? "可按需加载"
                      : "由平台助手调用"}
                </span>
              )}
              <span>查看详情 ↗</span>
            </footer>
          </button>
        ))}
      </div>
      {!items.length && <Blank title="没有匹配的能力" description="试试名称或其他关键词。" />}
      <p className="capability-footnote">
        系统内置项由平台维护，仅供平台助手使用，暂不支持绑定到业务 Agent。
        {data.conversationId
          ? "本任务次数来自已保存的成功调用记录，关闭或刷新后仍可追溯。"
          : "按需可用不代表任务已经读取或调用。"}
      </p>
      {detail && (
        <Drawer
          open
          title={
            <span className="capability-drawer-title">
              {kind === "skills" ? <BookOutlined /> : <ToolOutlined />}
              {detail.name}
              <Tag>v{detail.version}</Tag>
            </span>
          }
          size="min(720px, 100vw)"
          onClose={() => setSelected(undefined)}
        >
          <div className="skill-detail">
            <div className="skill-detail-head">
              <div className="skill-detail-head-meta">
                <Tag>系统内置</Tag>
                <Tag>只读</Tag>
                <span>
                  {kind === "skills" ? "平台助手按需读取的任务指导" : "平台助手的系统工具入口"}
                </span>
              </div>
            </div>
            <p className="skill-detail-desc">{detail.description}</p>
            <dl>
              <dt>使用范围</dt>
              <dd>平台助手专用 · 不可直接绑定业务 Agent</dd>
              <dt>使用条件</dt>
              <dd>
                {"unavailableReason" in detail && detail.unavailableReason
                  ? detail.unavailableReason
                  : "按当前用户权限使用；系统操作还会分别校验所需权限"}
              </dd>
              <dt>当前任务</dt>
              <dd>
                {data.conversationId
                  ? detail.usage.count
                    ? `已成功${kind === "skills" ? "读取" : "调用"} ${detail.usage.count} 次 · 最近 ${timestamp(detail.usage.lastUsedAt ?? "")}`
                    : "尚无成功调用记录"
                  : "未选择任务，仅展示能力目录"}
              </dd>
            </dl>
            <section className="skill-detail-section">
              <h3>{"instructions" in detail ? "指导内容" : "输入参数"}</h3>
              <pre className="skill-detail-source">
                {"instructions" in detail
                  ? detail.instructions
                  : JSON.stringify(detail.inputSchema, null, 2)}
              </pre>
            </section>
            <small className="resource-id">内容指纹 · {detail.digest}</small>
          </div>
        </Drawer>
      )}
    </>
  );
}
export function SystemCapabilityDirectory({ kind }: { kind: Kind }) {
  const query = useCapabilities();
  usePageActionReadiness(!!query.data && !query.isError);
  return (
    <QueryState label="系统能力" query={query}>
      {query.data && (
        <div className="capability-directory">
          <Cards interactive data={query.data} kind={kind} />
          {kind === "tools" && <Operations interactive data={query.data} />}
        </div>
      )}
    </QueryState>
  );
}
export function AssistantCapabilityDrawer({
  conversationId,
  running,
  onClose,
  onNavigate,
}: {
  conversationId?: string;
  running: boolean;
  onClose(): void;
  onNavigate(page: string): void;
}) {
  const query = useCapabilities(conversationId, running);
  const data = query.data;
  return (
    <Drawer
      open
      title={
        <span>
          <SafetyOutlined /> 我的能力
        </span>
      }
      size="min(980px, 100vw)"
      onClose={onClose}
      extra={
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          刷新能力
        </Button>
      }
    >
      <QueryState label="助手能力" query={query}>
        {data && (
          <div className="capability-directory">
            <div className="capability-intro">
              <span className="capability-eyebrow">平台助手 · 当前身份</span>
              <h2>了解我如何帮你工作</h2>
              <p>先发现资源，再按任务加载指导和调用工具。需要更改时，交由你审阅应用。</p>
              <div className="capability-permissions">
                {data.permissions.map((p) => (
                  <Tag key={p}>{permissionLabels[p]}</Tag>
                ))}
              </div>
            </div>
            <Tabs
              items={[
                {
                  key: "skills",
                  label: `内置 Skills · ${data.skills.length}`,
                  children: <Cards data={data} kind="skills" />,
                },
                {
                  key: "tools",
                  label: `系统工具 · ${data.tools.length}`,
                  children: (
                    <>
                      <Cards data={data} kind="tools" />
                      <Operations data={data} />
                    </>
                  ),
                },
                {
                  key: "project",
                  label: "项目能力",
                  children: (
                    <section className="capability-project">
                      <h3>复用项目已有的能力</h3>
                      <p>
                        我可以查询有权访问的 Skills 和工具，阅读定义，并为业务 Agent
                        准备绑定配置。项目工具和脚本不会自动成为我的执行权限。
                      </p>
                      <div className="capability-project-links">
                        {(["skills", "tools"] as const).map((page) => (
                          <Button
                            key={page}
                            icon={page === "skills" ? <BookOutlined /> : <ToolOutlined />}
                            disabled={!data.permissions.includes("resource.read")}
                            onClick={() => {
                              onClose();
                              onNavigate(page);
                            }}
                          >
                            查看项目{page === "skills" ? " Skills" : "工具"}
                          </Button>
                        ))}
                      </div>
                      {!data.permissions.includes("resource.read") && (
                        <p>当前角色没有资源读取权限，无法查看项目能力定义。</p>
                      )}
                    </section>
                  ),
                },
              ]}
            />
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}
