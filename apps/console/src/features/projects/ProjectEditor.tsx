import * as api from "@platform/sdk";
import { Form, Input } from "antd";
import { unwrap } from "../../shared/api";
import { type EditorCallbacks, EditorForm } from "../../shared/EditorForm";
export function ProjectEditor(props: EditorCallbacks) {
  const [form] = Form.useForm<{ name: string; description?: string }>();
  return (
    <EditorForm
      {...props}
      title="创建项目"
      form={form}
      onSubmit={async (values, signal) => {
        await unwrap(
          api.createProject({
            signal,
            body: { name: values.name, description: values.description ?? "" },
          }),
          signal,
        );
      }}
    >
      <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
        <Input placeholder="填写一个便于团队识别的名称" maxLength={80} />
      </Form.Item>
      <Form.Item name="description" label="说明">
        <Input.TextArea rows={2} placeholder="描述用途和适用场景" maxLength={500} />
      </Form.Item>
    </EditorForm>
  );
}
