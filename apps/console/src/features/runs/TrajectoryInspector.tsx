import { CloseOutlined } from "@ant-design/icons";
import { Button, Tabs, Tag } from "antd";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { timestamp } from "../../shared/api";
import { RunStatus } from "./RunStatus";
import { type TraceRecord, traceDuration, traceKinds, traceValue } from "./trajectory";

function plain(value: unknown) {
  return <pre>{traceValue(value).replace(/^(?:[ \t]*\r?\n)+/, "")}</pre>;
}
function Tools({ record }: { record: TraceRecord }) {
  return (
    <div className="trace-tools">
      <p className="trace-provenance">{record.toolsSource}</p>
      {record.tools?.length ? (
        record.tools.map((tool) => (
          <details key={tool.name}>
            <summary>
              <code>{tool.name}</code>
              <span>{tool.description || "未提供说明"}</span>
            </summary>
            {tool.inputSchema ? (
              <>
                <h4>参数定义</h4>
                {plain(tool.inputSchema)}
              </>
            ) : (
              <p className="trace-empty">此历史运行未保存工具定义，不能用当前定义替代。</p>
            )}
          </details>
        ))
      ) : (
        <p className="trace-empty">
          {record.toolsSource?.includes("历史")
            ? "未保存历史 Runtime 工具定义。"
            : "本次未注册工具。"}
        </p>
      )}
    </div>
  );
}
export function TrajectoryInspector({ record, close }: { record: TraceRecord; close(): void }) {
  const message = ["system", "user", "model"].includes(record.kind);
  const output = message ? record.text : record.kind === "context" ? record.input : record.output;
  const content =
    record.kind === "model" ? (
      record.text.trim() ? (
        <div className="trace-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {record.text}
          </Markdown>
        </div>
      ) : (
        <p className="trace-empty">模型未返回正文</p>
      )
    ) : (
      plain(output)
    );
  return (
    <section className="trace-inspector" aria-label="轨迹记录详情">
      <header>
        <div>
          <strong>{record.title}</strong>
          <small>
            {record.turn ? `第 ${record.turn} 轮` : "会话初始配置"} · {timestamp(record.startedAt)}
          </small>
        </div>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="关闭轨迹检查器"
          onClick={close}
        />
      </header>
      <p className="trace-provenance">
        <Tag>{traceKinds[record.kind]}</Tag>
        {record.source ?? "已持久化的调用记录"}
      </p>
      <Tabs
        size="small"
        items={[
          {
            key: "content",
            label:
              record.kind === "system"
                ? "系统提示词"
                : record.kind === "tool"
                  ? "结果"
                  : record.kind === "context"
                    ? "请求内容"
                    : "内容",
            children: content,
          },
          ...(record.request
            ? [{ key: "request", label: "请求内容", children: plain(record.request) }]
            : []),
          ...(record.execution
            ? [
                {
                  key: "execution",
                  label: "本轮运行",
                  children: (
                    <dl className="trace-facts">
                      <dt>状态</dt>
                      <dd>
                        <RunStatus status={record.execution.status} />
                      </dd>
                      <dt>运行 ID</dt>
                      <dd>{record.execution.id}</dd>
                      <dt>发布版本</dt>
                      <dd>v{record.execution.releaseVersion}</dd>
                      <dt>Runtime</dt>
                      <dd>{record.execution.runtimeId}</dd>
                      <dt>指定 Skills</dt>
                      <dd>
                        {record.execution.selectedSkills
                          ?.map((s) => `${s.name} · v${s.version}`)
                          .join("、") || "未指定"}
                      </dd>
                    </dl>
                  ),
                },
              ]
            : []),
          ...(record.kind === "tool"
            ? [{ key: "input", label: "参数", children: plain(record.input ?? record.text) }]
            : []),
          ...(record.tools
            ? [
                {
                  key: "tools",
                  label: `工具 (${record.tools.length})`,
                  children: <Tools record={record} />,
                },
              ]
            : []),
          ...(["tool", "model", "error"].includes(record.kind)
            ? [
                {
                  key: "timing",
                  label: "计时",
                  children: (
                    <dl className="trace-facts">
                      <dt>开始接收</dt>
                      <dd>{timestamp(record.startedAt)}</dd>
                      <dt>结束接收</dt>
                      <dd>{record.finishedAt ? timestamp(record.finishedAt) : "尚未记录"}</dd>
                      <dt>接收跨度</dt>
                      <dd>{traceDuration(record)}</dd>
                      <dt>计时来源</dt>
                      <dd>控制面接收事件的时间戳</dd>
                    </dl>
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
