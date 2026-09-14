import type { Principal } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, Button, Form, Input } from "antd";
import { useState } from "react";
import { unwrap } from "../../shared/api";
import { useOperation } from "../../shared/useOperation";

export function JoinTeam({ onJoined }: { onJoined(user: Principal): void }) {
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "",
  );
  const { busy, error, run } = useOperation();
  return (
    <div className="join-team">
      <section>
        <span className="eyebrow">Agent Platform</span>
        <h1>加入你的团队</h1>
        <p>设置个人账号，加入邀请指定的团队和项目。</p>
        {error && <Alert type="error" title={error} />}
        {!token ? (
          <Alert type="warning" title="缺少邀请链接，请联系管理员。" />
        ) : (
          <Form
            layout="vertical"
            requiredMark={false}
            disabled={busy}
            onFinish={(v: { username: string; displayName: string; password: string }) =>
              void run(async (signal) => {
                const user = await unwrap(api.acceptInvitation({ body: { ...v, token }, signal }));
                signal.throwIfAborted();
                window.history.replaceState(null, "", "/join");
                onJoined(user);
              })
            }
          >
            <Form.Item
              name="displayName"
              label="显示名称"
              rules={[{ required: true, whitespace: true, message: "请输入显示名称" }]}
            >
              <Input autoComplete="name" maxLength={80} />
            </Form.Item>
            <Form.Item
              name="username"
              label="登录账号"
              rules={[
                { required: true, message: "请输入账号" },
                {
                  pattern: /^[a-zA-Z0-9_-]{3,50}$/,
                  message: "使用 3–50 位字母、数字、下划线或连字符",
                },
              ]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: "请设置密码" },
                { min: 12, message: "密码至少 12 位" },
              ]}
            >
              <Input.Password autoComplete="new-password" maxLength={200} />
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={busy}>
              创建账号并加入
            </Button>
          </Form>
        )}
        <p className="form-note">
          邀请在 3 天内有效，只能使用一次。已有账号的成员请由项目管理员直接添加。
        </p>
        <a href="/login">返回登录</a>
      </section>
    </div>
  );
}
