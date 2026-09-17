import { ApiOutlined } from "@ant-design/icons";
import type { Tool, ToolProbe } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Form, Input, Select, Spin } from "antd";
import { useEffect, useState } from "react";
import { unwrap } from "../../shared/api";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";

type Values = {
  name: string;
  description: string;
  kind: "sum" | "http_get";
  url?: string;
  bearerToken?: string;
  inputSchema: string;
  outputSchema: string;
  sample: string;
};
/** A runnable starting point, so an operator sees the shape the Runtime will send. */
const sampleDefaults = {
  sum: '{\n  "values": [1, 2, 3]\n}',
  http_get: "{}",
} as const;
const schemaDefaults = {
  input: '{"type":"object","properties":{},"additionalProperties":false}',
  output: '{"type":"object"}',
} as const;
type Probe =
  | { state: "idle" }
  | { state: "probing" }
  /** `signature` records what was called, so a later edit stops the verdict describing it. */
  | { state: "done"; signature: string; result: ToolProbe }
  /** The request never reached the service; this is not a verdict about the tool. */
  | { state: "failed"; message: string };
/**
 * Each outcome names a different fix. Only `mismatch` means the operator's own
 * declaration is wrong, and treating it like a service failure would send them
 * looking at the wrong thing.
 */
const probeVerdicts = {
  ok: { type: "success" as const, title: "调用成功，返回符合声明的输出 schema" },
  invalid: { type: "warning" as const, title: "样例参数不符合输入 schema，未发出请求" },
  rejected: { type: "error" as const, title: "服务已响应，但拒绝了调用或未返回 JSON" },
  mismatch: { type: "error" as const, title: "服务返回了 JSON，但不符合声明的输出 schema" },
  unreachable: { type: "warning" as const, title: "平台无法连接该地址" },
  timeout: { type: "warning" as const, title: "平台等待服务响应超时" },
};
function ProbeVerdict({ result }: { result: ToolProbe }) {
  const verdict = probeVerdicts[result.outcome];
  return (
    <Alert
      type={verdict.type}
      title={verdict.title}
      showIcon
      className="form-alert"
      description={
        <>
          <span>{result.message}</span>
          <small className="probe-facts">
            {result.httpStatus === null ? "未收到 HTTP 响应" : `HTTP ${result.httpStatus}`}
            {result.latencyMs === null ? "" : ` · 用时 ${result.latencyMs} ms`}
          </small>
          {result.requestUrl ? (
            <small className="probe-facts">
              实际请求 <code className="code-input">{result.requestUrl}</code>
            </small>
          ) : null}
          {result.preview ? (
            <small className="probe-facts">
              返回内容 <code className="code-input">{result.preview}</code>
            </small>
          ) : null}
          {result.outcome === "unreachable" || result.outcome === "timeout" ? (
            <small className="probe-facts">
              这只说明平台侧网络不通。Runtime
              可能位于另一个网络，能连接该地址，因此不要据此判断接口配置有误。
            </small>
          ) : null}
          {result.outcome === "mismatch" ? (
            <small className="probe-facts">
              服务本身工作正常，需要修正的是上面填写的输出 JSON Schema。
            </small>
          ) : null}
        </>
      }
    />
  );
}
export function ToolEditor({
  projectId,
  tool,
  ...props
}: EditorCallbacks & { projectId: string; tool?: Tool }) {
  const [form] = Form.useForm<Values>();
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const toolKind = Form.useWatch("kind", form);
  // The watched values arrive after the first render, so the verdict is keyed to
  // what was called instead of being cleared by an effect that would fire late.
  const sample = Form.useWatch("sample", form),
    url = Form.useWatch("url", form),
    signature = `${toolKind ?? ""}|${url ?? ""}|${sample ?? ""}`;
  useEffect(() => {
    form.resetFields();
    form.setFieldsValue(
      tool
        ? {
            name: tool.name,
            description: tool.description,
            // An imported MCP tool never reaches this editor; the console routes
            // those to the MCP service. The fallback keeps the type total.
            kind: tool.kind === "mcp" ? "http_get" : tool.kind,
            url: tool.url,
            bearerToken: "",
            inputSchema: JSON.stringify(tool.inputSchema, null, 2),
            outputSchema: JSON.stringify(tool.outputSchema, null, 2),
            sample: sampleDefaults[tool.kind === "mcp" ? "http_get" : tool.kind],
          }
        : {
            kind: "sum",
            url: "",
            bearerToken: "",
            inputSchema: schemaDefaults.input,
            outputSchema: schemaDefaults.output,
            sample: sampleDefaults.sum,
          },
    );
  }, [form, tool]);
  async function runProbe() {
    // The kind is read from form state rather than from the watcher: the watcher
    // is only populated after a render, and this decides which fields are
    // required. Only the fields that matter are validated, so the request is
    // built from the full form state rather than from the validated subset.
    const kind = form.getFieldValue("kind") as Values["kind"] | undefined;
    try {
      await form.validateFields(kind === "sum" ? ["kind", "sample"] : ["kind", "url", "sample"]);
    } catch {
      return;
    }
    const values = form.getFieldsValue();
    let sampleValue: unknown, inputSchema: unknown, outputSchema: unknown;
    try {
      sampleValue = JSON.parse(values.sample || "{}");
      inputSchema = JSON.parse(values.inputSchema);
      outputSchema = JSON.parse(values.outputSchema);
    } catch {
      setProbe({ state: "failed", message: "样例参数或 JSON Schema 不是合法的 JSON。" });
      return;
    }
    setProbe({ state: "probing" });
    const token = values.bearerToken;
    try {
      const result = await unwrap(
        api.probeTool({
          path: { projectId },
          body: {
            kind: values.kind,
            url: values.url ?? "",
            inputSchema: inputSchema as Record<string, unknown>,
            outputSchema: outputSchema as Record<string, unknown>,
            input: sampleValue as Record<string, unknown>,
            // A blank token on an existing tool reuses its stored credential.
            ...(token ? { bearerToken: token } : tool ? { credentialFrom: tool.id } : {}),
          },
        }),
      );
      setProbe({
        state: "done",
        // Keyed to the values actually called, not to the watched ones.
        signature: `${values.kind ?? ""}|${values.url ?? ""}|${values.sample ?? ""}`,
        result,
      });
    } catch (error) {
      setProbe({
        state: "failed",
        message: error instanceof Error ? error.message : "无法发出探测请求。",
      });
    }
  }
  const editing = !!tool;
  return (
    <EditorForm
      {...props}
      title={editing ? "编辑工具" : "登记工具"}
      form={form}
      onSubmit={async (values, signal) => {
        const body = {
          name: values.name,
          description: values.description,
          kind: values.kind,
          url: values.url ?? "",
          inputSchema: JSON.parse(values.inputSchema),
          outputSchema: JSON.parse(values.outputSchema),
        };
        if (tool)
          await unwrap(
            api.updateTool({
              signal,
              path: { projectId, id: tool.id },
              // Leaving the token blank keeps the stored credential.
              body: { ...body, ...(values.bearerToken ? { bearerToken: values.bearerToken } : {}) },
            }),
            signal,
          );
        else
          await unwrap(
            api.createTool({
              signal,
              path: { projectId },
              body: { ...body, bearerToken: values.bearerToken ?? "" },
            }),
            signal,
          );
      }}
    >
      <Form.Item
        name="name"
        label="工具调用名"
        rules={[
          { required: true, message: "请输入名称" },
          { pattern: /^[a-z][a-z0-9_]{1,49}$/, message: "使用小写字母、数字和下划线，字母开头" },
        ]}
      >
        <Input placeholder="例如：sum_values" maxLength={80} />
      </Form.Item>
      <Form.Item
        name="description"
        label="说明"
        rules={[{ required: true, message: "请说明工具的用途，供 Agent 选择" }]}
      >
        <Input.TextArea rows={2} placeholder="描述用途和适用场景" maxLength={500} />
      </Form.Item>
      <Form.Item
        name="kind"
        label="执行方式"
        extra={editing ? "执行方式决定调用协议，登记后不可更改。" : undefined}
      >
        <Select
          disabled={editing}
          options={[
            { label: "内置求和 · 确定性工具", value: "sum" },
            { label: "HTTP GET · 只读 JSON 接口", value: "http_get" },
          ]}
        />
      </Form.Item>
      {toolKind === "sum" ? (
        <Alert type="info" title="输入 values 数字数组，返回 total。平台自动固定输入输出约束。" />
      ) : (
        <>
          <Form.Item
            name="url"
            label="接口地址"
            rules={[
              { required: true, message: "请输入接口地址" },
              { type: "url", message: "请输入完整地址" },
            ]}
          >
            <Input placeholder="https://business.example.com/orders" />
          </Form.Item>
          <Form.Item
            name="bearerToken"
            label="服务凭据（可选）"
            extra={editing ? "留空表示保留已保存的凭据。" : undefined}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="inputSchema"
            label="输入 JSON Schema"
            rules={[{ required: true }, jsonRule("输入 schema")]}
          >
            <Input.TextArea rows={5} className="code-input" />
          </Form.Item>
          <Form.Item
            name="outputSchema"
            label="输出 JSON Schema"
            rules={[{ required: true }, jsonRule("输出 schema")]}
          >
            <Input.TextArea rows={4} className="code-input" />
          </Form.Item>
        </>
      )}
      <section className="model-probe">
        <div>
          <strong>存盘前先验证</strong>
          <span>
            {toolKind === "sum"
              ? "平台本地按样例参数求值，并校验结果是否符合声明的输出 schema，不发出任何请求。"
              : "按 Runtime 实际调用工具的方式请求一次：把样例参数拼进查询参数并校验返回。"}
          </span>
        </div>
        <Button
          icon={probe.state === "probing" ? <Spin size="small" /> : <ApiOutlined />}
          onClick={() => void runProbe()}
        >
          测试调用
        </Button>
      </section>
      <Form.Item
        name="sample"
        label="样例参数"
        extra={
          toolKind === "sum"
            ? "只用于本次测试调用，不会保存到工具上。"
            : "按输入 schema 填写；这些键会作为查询参数拼到接口地址上。"
        }
      >
        <Input.TextArea rows={4} className="code-input" />
      </Form.Item>
      {probe.state === "done" && probe.signature === signature && (
        <ProbeVerdict result={probe.result} />
      )}
      {probe.state === "failed" && (
        // Not 「探测请求未发出」: the request can reach the platform and come
        // back as an error (a 404 for a route the running backend lacks), so the
        // title must not claim it never left. The message names the cause.
        <Alert type="error" title="没能完成测试调用" description={probe.message} showIcon />
      )}
      <p className="form-note">
        手写工具只支持只读调用。MCP 工具在「MCP 服务」中导入，导入时按服务声明的 readOnlyHint
        判定；未声明只读的工具每次调用都需要人工确认，且不能在此外编辑。
      </p>
    </EditorForm>
  );
}
/** Rejects a schema that is not JSON before the server sees it, so the error is local and specific. */
function jsonRule(label: string) {
  return {
    validator(_: unknown, value: string) {
      if (!value) return Promise.resolve();
      try {
        JSON.parse(value);
        return Promise.resolve();
      } catch {
        return Promise.reject(new Error(`${label} 不是合法的 JSON`));
      }
    },
  };
}
