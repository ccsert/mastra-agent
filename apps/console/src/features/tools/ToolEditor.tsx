import * as api from "@platform/sdk";
import { Alert, Form, Input, Select } from "antd";
import { useEffect } from "react";
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
};
export function ToolEditor({ projectId, ...props }: EditorCallbacks & { projectId: string }) {
  const [form] = Form.useForm<Values>();
  const toolKind = Form.useWatch("kind", form);
  useEffect(
    () =>
      form.setFieldsValue({
        kind: "sum",
        inputSchema: '{"type":"object","properties":{},"additionalProperties":false}',
        outputSchema: '{"type":"object"}',
      }),
    [form],
  );
  return (
    <EditorForm
      {...props}
      title="登记工具"
      form={form}
      onSubmit={async (values, signal) => {
        await unwrap(
          api.createTool({
            signal,
            path: { projectId },
            body: {
              name: values.name,
              description: values.description,
              kind: values.kind,
              url: values.url ?? "",
              bearerToken: values.bearerToken ?? "",
              inputSchema: JSON.parse(values.inputSchema),
              outputSchema: JSON.parse(values.outputSchema),
            },
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
      <Form.Item name="kind" label="执行方式">
        <Select
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
          <Form.Item name="bearerToken" label="服务凭据（可选）">
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="inputSchema" label="输入 JSON Schema" rules={[{ required: true }]}>
            <Input.TextArea rows={5} className="code-input" />
          </Form.Item>
          <Form.Item name="outputSchema" label="输出 JSON Schema" rules={[{ required: true }]}>
            <Input.TextArea rows={4} className="code-input" />
          </Form.Item>
        </>
      )}
      <p className="form-note">
        当前入口登记只读工具。MCP 工具在「MCP 服务」中导入；业务写入审批尚未开放。
      </p>
    </EditorForm>
  );
}
