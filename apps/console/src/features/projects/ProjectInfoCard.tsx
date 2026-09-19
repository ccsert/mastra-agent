import { InboxOutlined, RestOutlined } from "@ant-design/icons";
import * as api from "@platform/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, Tag } from "antd";
import { useEffect } from "react";
import { useProjectAccess } from "../../shared/access";
import { timestamp, unwrap } from "../../shared/api";
import { projectKey, useProjectId, useProjectQuery } from "../../shared/data/ProjectData";
import { useOperation } from "../../shared/useOperation";

/** Project basics on the settings page: rename, description, archive and restore.
 * Archiving freezes writes platform-wide; the project stays readable and can be restored. */
export function ProjectInfoCard({
  refreshProjects,
}: {
  refreshProjects?: (chooseNewest?: boolean) => Promise<void>;
}) {
  const projectId = useProjectId();
  const access = useProjectAccess();
  const canManage = access?.permissions?.includes("project.manage") ?? false;
  const project = useProjectQuery("project");
  const client = useQueryClient();
  const { modal, message } = App.useApp();
  const [form] = Form.useForm<{ name: string; description?: string }>();
  const operation = useOperation();
  const current = project.data;
  useEffect(() => {
    if (current) form.setFieldsValue({ name: current.name, description: current.description });
  }, [current, form]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: projectKey(projectId, "project") });
    await client.invalidateQueries({ queryKey: projectKey(projectId, "access") });
    await refreshProjects?.();
  };
  if (!canManage)
    return current ? (
      <p className="form-note">
        {current.archivedAt ? "此项目已归档，修改与执行已暂停。" : "项目信息仅项目管理员可修改。"}
      </p>
    ) : null;
  const archived = !!current?.archivedAt;
  return (
    <section className="project-info-card" aria-label="项目信息">
      <div className="project-info-head">
        <strong>{current?.name ?? "项目信息"}</strong>
        {archived && current?.archivedAt && (
          <Tag color="warning">已归档 · {timestamp(current.archivedAt)}</Tag>
        )}
      </div>
      {operation.error && <Alert type="error" title={operation.error} showIcon />}
      <Form
        disabled={operation.busy}
        form={form}
        layout="vertical"
        onFinish={(values: { name: string; description?: string }) =>
          operation.run(async () => {
            await unwrap(
              api.updateProject({
                path: { projectId },
                body: { name: values.name, description: values.description ?? "" },
              }),
            );
            message.success("项目信息已更新");
            await refresh();
          })
        }
      >
        <div className="project-info-fields">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: "请输入名称" }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input maxLength={500} placeholder="描述用途和适用场景" />
          </Form.Item>
        </div>
        <div className="project-info-actions">
          <Button htmlType="submit" loading={operation.busy}>
            保存项目信息
          </Button>
          {archived ? (
            <Button
              icon={<RestOutlined aria-hidden="true" />}
              disabled={operation.busy}
              onClick={() =>
                void modal.confirm({
                  title: `恢复项目 ${current?.name}？`,
                  content: "恢复后团队成员与应用可以继续在这个项目中修改和执行。",
                  okText: "恢复项目",
                  cancelText: "取消",
                  onOk: () =>
                    operation.run(async () => {
                      await unwrap(api.unarchiveProject({ path: { projectId }, body: {} }));
                      message.success("项目已恢复");
                      await refresh();
                    }),
                })
              }
            >
              恢复项目
            </Button>
          ) : (
            <Button
              danger
              icon={<InboxOutlined aria-hidden="true" />}
              disabled={operation.busy}
              onClick={() =>
                void modal.confirm({
                  title: `归档项目 ${current?.name}？`,
                  content:
                    "归档后项目仍可查看，但配置修改、发布与新的执行都会暂停，应用接入也会被拒绝。随时可以在项目设置中恢复。",
                  okText: "归档项目",
                  cancelText: "取消",
                  onOk: () =>
                    operation.run(async () => {
                      await unwrap(api.archiveProject({ path: { projectId }, body: {} }));
                      message.success("项目已归档");
                      await refresh();
                    }),
                })
              }
            >
              归档项目
            </Button>
          )}
        </div>
      </Form>
      <p className="form-note">
        归档影响这个项目的所有成员与应用接入，并会记录在团队操作记录中；随时可以恢复。
      </p>
    </section>
  );
}
