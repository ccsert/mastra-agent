import * as api from "@platform/sdk";
import { Alert, Form, Input, InputNumber, Select } from "antd";
import { useEffect } from "react";
import { unwrap } from "../../shared/api";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";

type Values = {
  name: string;
  baseUrl: string;
  modelId: string;
  modelKind: "chat" | "embedding" | "rerank";
  apiKey?: string;
  dimensions?: number;
};
export function ModelEditor({ projectId, ...props }: EditorCallbacks & { projectId: string }) {
  const [form] = Form.useForm<Values>();
  const modelKind = Form.useWatch("modelKind", form);
  useEffect(() => form.setFieldsValue({ modelKind: "chat" }), [form]);
  return (
    <EditorForm
      {...props}
      title="接入模型服务"
      form={form}
      onSubmit={async (values, signal) => {
        await unwrap(
          api.createModel({
            signal,
            path: { projectId },
            body: {
              name: values.name,
              baseUrl: values.baseUrl,
              modelId: values.modelId,
              kind: values.modelKind,
              apiKey: values.apiKey ?? "",
              ...(values.modelKind === "embedding" && values.dimensions
                ? { dimensions: values.dimensions }
                : {}),
            },
          }),
          signal,
        );
      }}
    >
      <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
        <Input placeholder="填写一个便于团队识别的名称" maxLength={80} />
      </Form.Item>
      <p className="form-note">
        接入对话、向量或重排服务。模型凭据加密保存，浏览器不会收到已保存的密钥。
      </p>
      <Form.Item name="modelKind" label="服务能力">
        <Select
          options={[
            { value: "chat", label: "对话 · Chat Completions" },
            { value: "embedding", label: "向量 · Embeddings" },
            { value: "rerank", label: "重排 · Rerank" },
          ]}
        />
      </Form.Item>
      <Form.Item
        name="baseUrl"
        label="Base URL"
        rules={[
          { required: true, message: "请输入服务地址" },
          { type: "url", message: "请输入完整 HTTP(S) 地址" },
        ]}
      >
        <Input placeholder="https://api.example.com/v1" />
      </Form.Item>
      <Form.Item
        name="modelId"
        label="模型 ID"
        rules={[{ required: true, message: "请输入模型服务中的模型 ID" }]}
      >
        <Input placeholder="服务提供的模型标识" />
      </Form.Item>
      <Form.Item name="apiKey" label="API Key">
        <Input.Password autoComplete="new-password" placeholder="无鉴权的自建服务可留空" />
      </Form.Item>
      {modelKind === "embedding" && (
        <Form.Item
          name="dimensions"
          label="向量维度（可选）"
          extra="作为 dimensions 参数发送；不填则使用模型默认值。知识库会固定实际维度。"
        >
          <InputNumber
            min={1}
            max={16000}
            precision={0}
            placeholder="例如 1024"
            style={{ width: "100%" }}
          />
        </Form.Item>
      )}
      <Alert
        type="info"
        title="对话模型通过 Agent 验证；向量和重排模型通过文档入库及检索测试验证。"
      />
    </EditorForm>
  );
}
