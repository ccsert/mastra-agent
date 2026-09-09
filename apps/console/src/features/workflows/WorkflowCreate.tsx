import type { WorkflowAsset } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Form, Input, Modal } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { useOperation } from "../../shared/useOperation";
import { emptyWorkflow } from "./model/workflow-model";
export function WorkflowCreate({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose(): void;
  onCreated(asset: WorkflowAsset): void;
}) {
  const { busy, error, run } = useOperation(),
    refresh = useProjectRefresh();
  const [name, setName] = useState("");
  return (
    <Modal
      title="创建工作流"
      open
      onCancel={onClose}
      okText="创建并编排"
      confirmLoading={busy}
      okButtonProps={{ disabled: !name.trim() || busy }}
      onOk={() =>
        run(async (signal) => {
          const created = await unwrap(
            api.createWorkflow({ path: { projectId }, body: emptyWorkflow(name.trim()), signal }),
            signal,
          );
          void refresh("workflows");
          onCreated(created);
        })
      }
    >
      {error && <Alert title={error} type="error" />}
      <Form layout="vertical" component="div">
        <Form.Item label="工作流名称" htmlFor="workflow-create-name" required>
          <Input
            id="workflow-create-name"
            placeholder="例如：订单采购报告"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
