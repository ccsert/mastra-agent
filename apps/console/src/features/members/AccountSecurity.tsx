import { SafetyCertificateOutlined } from "@ant-design/icons";
import type { Principal } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, App, Button, Form, Input, Modal } from "antd";
import { unwrap } from "../../shared/api";
import { useOperation } from "../../shared/useOperation";

type PasswordValues = { currentPassword: string; newPassword: string; confirm: string };

/** Self-service account security: password change and signing out other devices.
 * Available to every signed-in member from the sidebar user row. */
export function AccountSecurity({
  user,
  open,
  onClose,
}: {
  user: Principal;
  open: boolean;
  onClose(): void;
}) {
  const { modal, message } = App.useApp();
  const [form] = Form.useForm<PasswordValues>();
  const operation = useOperation();
  const close = () => {
    if (operation.busy) return;
    form.resetFields();
    operation.setError("");
    onClose();
  };
  const revokeOthers = () =>
    void modal.confirm({
      title: "退出其他设备的登录？",
      content: "当前设备保持登录，其他设备会被登出并需要重新输入密码。",
      okText: "退出其他设备",
      cancelText: "取消",
      onOk: () =>
        operation.run(async () => {
          const result = await unwrap(api.revokeMyOtherSessions({ body: {} }));
          message.success(
            result.revoked > 0
              ? `已退出其他设备的 ${result.revoked} 个会话`
              : "当前没有其他设备的会话",
          );
        }),
    });
  return (
    <Modal
      title={
        <>
          <SafetyCertificateOutlined aria-hidden="true" /> 账号安全 · {user.displayName}
        </>
      }
      open={open}
      onCancel={close}
      footer={null}
      width={440}
    >
      <p className="form-note">登录密码至少 12 位。修改密码后，其他设备会被退出登录。</p>
      <Form
        disabled={operation.busy}
        form={form}
        layout="vertical"
        onFinish={(values: PasswordValues) =>
          operation.run(async () => {
            const result = await unwrap(
              api.changePassword({
                body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
              }),
            );
            form.resetFields();
            message.success(
              result.revokedSessions > 0
                ? `密码已修改，其他设备的 ${result.revokedSessions} 个会话已退出`
                : "密码已修改",
            );
            onClose();
          })
        }
      >
        <Form.Item
          name="currentPassword"
          label="当前密码"
          rules={[{ required: true, message: "请输入当前密码" }]}
        >
          <Input.Password autoComplete="current-password" maxLength={200} />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 12, message: "新密码至少 12 位" },
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={200} />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={["newPassword"]}
          rules={[
            { required: true, message: "请再次输入新密码" },
            ({ getFieldValue }) => ({
              validator(_, value) {
                return !value || value === getFieldValue("newPassword")
                  ? Promise.resolve()
                  : Promise.reject(new Error("两次输入的密码不一致"));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={200} />
        </Form.Item>
        {operation.error && <Alert type="error" title={operation.error} showIcon />}
        <div className="account-security-actions">
          <Button onClick={revokeOthers}>退出其他设备</Button>
          <Button type="primary" htmlType="submit" loading={operation.busy}>
            修改密码
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
