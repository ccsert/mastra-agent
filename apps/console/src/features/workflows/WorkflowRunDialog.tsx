import type { WorkflowRelease, WorkflowRun } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Form, Input, Modal, Select } from "antd";
import { type ReactNode, useState } from "react";
import { v4 as uuid } from "uuid";
import { timestamp, unwrap } from "../../shared/api";
import { useProjectRefresh } from "../../shared/data/ProjectData";
import { useOperation } from "../../shared/useOperation";
import { initialInput } from "./draft";
export function WorkflowRunDialog({
  projectId,
  workflowId,
  initialRelease,
  releases,
  pagination,
  onClose,
  onStarted,
}: {
  projectId: string;
  workflowId: string;
  initialRelease: WorkflowRelease;
  releases: WorkflowRelease[];
  pagination?: ReactNode;
  onClose(): void;
  onStarted(run: WorkflowRun): void;
}) {
  const { busy, error, run: guard } = useOperation(),
    refresh = useProjectRefresh();
  const path = { projectId, id: workflowId };
  const [releaseId, setReleaseId] = useState(initialRelease.id),
    [runInput, setRunInput] = useState(
      JSON.stringify(initialInput(initialRelease.snapshot.definition.inputSchema), null, 2),
    );
  return (
    <Modal
      title="运行已发布工作流"
      open
      onCancel={() => onClose()}
      okText="开始执行"
      confirmLoading={busy}
      okButtonProps={{ disabled: !releaseId || busy }}
      onOk={() =>
        void guard(async (signal) => {
          const input = JSON.parse(runInput);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("运行输入必须为 JSON 对象");
          const run = await unwrap(
            api.createWorkflowRun({
              path,
              signal,
              body: { releaseId: releaseId ?? "", input, requestId: uuid() },
            }),
            signal,
          );
          void refresh("workflows");
          onStarted(run);
        })
      }
    >
      {error && <Alert title={error} type="error" />}
      <Form layout="vertical" component="div">
        <Form.Item label="发布版本" htmlFor="workflow-run-version">
          <Select
            id="workflow-run-version"
            value={releaseId}
            options={releases.map((r) => ({
              label: `v${r.version} · ${timestamp(r.createdAt)}`,
              value: r.id,
            }))}
            onChange={(id) => {
              setReleaseId(id);
              const r = releases.find((r) => r.id === id);
              if (r)
                setRunInput(
                  JSON.stringify(initialInput(r.snapshot.definition.inputSchema), null, 2),
                );
            }}
          />
        </Form.Item>
        {pagination}
        <Form.Item
          label="运行输入"
          htmlFor="workflow-run-input"
          extra="预填值是合成样例，请按业务任务调整。"
        >
          <Input.TextArea
            id="workflow-run-input"
            value={runInput}
            rows={8}
            onChange={(e) => setRunInput(e.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
