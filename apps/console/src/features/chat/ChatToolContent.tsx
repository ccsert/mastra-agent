import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Button, Tabs } from "antd";
import { AgentText } from "../../shared/ai/AgentText";
import { ToolResult } from "../../shared/ai/ToolResult";
import { asRecord } from "../../shared/ai/tool-content";
import { useCopyToClipboard } from "../../shared/assistant-ui";

function CopyContent({ text }: { text: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <Button
      type="text"
      size="small"
      disabled={!text}
      aria-label={isCopied ? "已复制内容" : "复制内容"}
      title={isCopied ? "已复制内容" : "复制内容"}
      icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
      onClick={() => copyToClipboard(text)}
    />
  );
}
function RawContent({ text, terminal = false }: { text: string; terminal?: boolean }) {
  return (
    <div className="chat-raw-content">
      <CopyContent text={text} />
      <pre className={terminal ? "tool-terminal" : "tool-result-raw"}>{text || "（空）"}</pre>
    </div>
  );
}
function SkillDocument({
  text,
  title,
  markdown,
}: {
  text: string;
  title: string;
  markdown: boolean;
}) {
  return (
    <section className="chat-tool-document" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <span>
          {text.split("\n").length} 行 · {text.length.toLocaleString()} 字符
        </span>
      </header>
      {markdown ? (
        <Tabs
          size="small"
          items={[
            {
              key: "read",
              label: "阅读",
              children: (
                <div className="chat-document-body">
                  <AgentText text={text} plainLocalLinks />
                </div>
              ),
            },
            { key: "raw", label: "原文", children: <RawContent text={text} /> },
          ]}
        />
      ) : (
        <RawContent text={text} />
      )}
    </section>
  );
}
function ScriptResult({
  result,
}: {
  result: Record<string, unknown> & { stdout: string; stderr: string; exitCode: number };
}) {
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    /* Keep non-JSON stdout as text. */
  }
  return (
    <section className="chat-script-result" aria-label="脚本执行结果">
      <header>
        <div>
          <strong>{String(result.skill ?? "Skill 脚本")}</strong>
          {typeof result.version === "number" && <span>v{result.version}</span>}
          <code>{String(result.entrypoint ?? "")}</code>
        </div>
        <span data-failed={result.exitCode !== 0}>退出码 {result.exitCode}</span>
      </header>
      <Tabs
        size="small"
        defaultActiveKey={result.exitCode !== 0 ? "console" : "result"}
        items={[
          {
            key: "result",
            label: "结果",
            children:
              data !== undefined ? (
                <ToolResult result={data} />
              ) : (
                <RawContent text={result.stdout} terminal />
              ),
          },
          {
            key: "console",
            label: `输出${result.stderr ? " · 有 stderr" : ""}`,
            children: (
              <div className="chat-script-streams">
                <section aria-label="标准输出">
                  <h4>stdout · {result.stdout.length} 字符</h4>
                  <RawContent text={result.stdout} terminal />
                </section>
                <section aria-label="标准错误">
                  <h4>stderr · {result.stderr.length} 字符</h4>
                  <RawContent text={result.stderr} terminal />
                </section>
              </div>
            ),
          },
          {
            key: "record",
            label: "完整记录",
            children: <RawContent text={JSON.stringify(result, null, 2)} />,
          },
        ]}
      />
    </section>
  );
}
export function ChatToolContent({
  toolName,
  args,
  result,
}: Pick<ToolCallMessagePartProps, "toolName" | "args" | "result">) {
  const input = asRecord(args),
    value = asRecord(result);
  const screenshot = value.mediaType === "image/png" ? value.data : value.base64;
  if (toolName === "browser_screenshot" && typeof screenshot === "string") {
    const valid =
      screenshot.length <= 7 * 1024 * 1024 && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(screenshot);
    const { base64: _legacyImage, data: _image, ...metadata } = value;
    return (
      <section className="chat-tool-screenshot" aria-label="浏览器截图">
        {valid ? (
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt="Agent 在任务浏览器中捕获的页面"
            loading="lazy"
          />
        ) : (
          <p>截图不可直接显示，请从本轮成果下载原文件。</p>
        )}
        <details className="chat-call-details">
          <summary>截图信息</summary>
          <ToolResult result={metadata} />
        </details>
      </section>
    );
  }
  if (toolName === "mastra_workspace_execute_command" && typeof value.stdout === "string")
    return (
      <section aria-label="命令输出">
        <p>退出码 {String(value.exitCode ?? "未记录")}</p>
        <RawContent text={[value.stdout, value.stderr].filter(Boolean).join("\n")} terminal />
      </section>
    );
  if (toolName === "skill" && typeof result === "string")
    return (
      <SkillDocument
        text={result}
        title={`Skill 指南 · ${String(input.name ?? "未命名")}`}
        markdown
      />
    );
  if (toolName === "skill_read" && typeof result === "string") {
    const path = String(input.path ?? "Skill 文件"),
      range =
        typeof input.startLine === "number"
          ? ` · L${input.startLine}${typeof input.endLine === "number" ? `–${input.endLine}` : "起"}`
          : "";
    return (
      <SkillDocument
        text={result}
        title={`${String(input.skillName ?? "Skill")} / ${path}${range}`}
        markdown={/\.(md|markdown|mdown)$/i.test(path)}
      />
    );
  }
  if (
    toolName === "run_skill_script" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.exitCode === "number"
  )
    return (
      <ScriptResult
        result={{ ...value, stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode }}
      />
    );
  return <ToolResult toolName={toolName} result={result} />;
}
