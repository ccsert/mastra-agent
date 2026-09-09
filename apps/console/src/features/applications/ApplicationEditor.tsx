import type { Application } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Form, Input } from "antd";
import { unwrap } from "../../shared/api";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";
export function ApplicationEditor({
  projectId,
  onCredential,
  ...props
}: EditorCallbacks & {
  projectId: string;
  onCredential(value: Application & { secretKey: string }): void;
}) {
  const [form] = Form.useForm<{ name: string }>();
  return (
    <EditorForm
      {...props}
      title="创建应用凭据"
      form={form}
      onSubmit={async (values, signal) => {
        const credential = await unwrap(
          api.createApplication({ signal, path: { projectId }, body: { name: values.name } }),
          signal,
        );
        onCredential(credential);
      }}
    >
      <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
        <Input placeholder="填写一个便于团队识别的名称" maxLength={80} />
      </Form.Item>
      <Alert
        type="info"
        title="凭据限定当前项目，仅能调用已发布 Agent。SK 只在创建后显示一次，请保存在业务后端。"
      />
    </EditorForm>
  );
}
