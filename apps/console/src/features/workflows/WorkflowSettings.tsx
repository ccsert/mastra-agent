import type { WorkflowAssetInput } from "@platform/sdk";
import { Alert, Form, Input, Modal } from "antd";
import { useState } from "react";
import { useOperation } from "../../shared/useOperation";
export function WorkflowSettings({
  initial,
  onClose,
  onApply,
}: {
  initial: WorkflowAssetInput;
  onClose(): void;
  onApply(value: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }): Promise<void>;
}) {
  const { busy, error, run: guard } = useOperation();
  const [settingsName, setSettingsName] = useState(initial.name),
    [settingsDescription, setSettingsDescription] = useState(initial.description ?? ""),
    [inputSchema, setInputSchema] = useState(
      JSON.stringify(initial.definition.inputSchema, null, 2),
    ),
    [outputSchema, setOutputSchema] = useState(
      JSON.stringify(initial.definition.outputSchema, null, 2),
    );
  return (
    <Modal
      title="流程设置"
      open
      onCancel={() => {
        if (!busy) onClose();
      }}
      width="min(850px, 96vw)"
      okText="应用设置"
      confirmLoading={busy}
      onOk={() =>
        void guard(async (signal) => {
          let input: Record<string, unknown>, output: Record<string, unknown>;
          try {
            input = JSON.parse(inputSchema);
            output = JSON.parse(outputSchema);
            if (input?.type !== "object" || output?.type !== "object" || !settingsName.trim())
              throw new Error();
          } catch {
            throw new Error("名称不能为空，输入输出必须是有效的 object JSON Schema");
          }
          await onApply({
            name: settingsName.trim(),
            description: settingsDescription,
            inputSchema: input,
            outputSchema: output,
          });
          signal.throwIfAborted();
          onClose();
        })
      }
    >
      {error && <Alert title={error} type="error" />}
      <Form layout="vertical" component="div">
        <Form.Item label="名称" htmlFor="workflow-settings-name">
          <Input
            id="workflow-settings-name"
            value={settingsName}
            maxLength={80}
            onChange={(e) => setSettingsName(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="说明" htmlFor="workflow-settings-description">
          <Input
            id="workflow-settings-description"
            value={settingsDescription}
            maxLength={500}
            onChange={(e) => setSettingsDescription(e.target.value)}
          />
        </Form.Item>
        <p className="muted">以下契约通常由 AI 自动生成；调整字段后需重新校验引用。</p>
        <div className="workflow-schema-grid">
          <Form.Item label="输入 JSON Schema" htmlFor="workflow-input-schema">
            <Input.TextArea
              id="workflow-input-schema"
              value={inputSchema}
              rows={12}
              onChange={(e) => setInputSchema(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="输出 JSON Schema" htmlFor="workflow-output-schema">
            <Input.TextArea
              id="workflow-output-schema"
              value={outputSchema}
              rows={12}
              onChange={(e) => setOutputSchema(e.target.value)}
            />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
