import {
  ApiOutlined,
  ArrowRightOutlined,
  DeploymentUnitOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { Principal } from "@platform/sdk";
import * as api from "@platform/sdk";
import { Alert, App as AntApp, Button, Form, Input, Spin } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { unwrap } from "../api";
import { useLifetime } from "../useLifetime";

export interface ConsoleSession {
  user: Principal;
  logout(): Promise<void>;
}
export function SessionBoundary({ children }: { children(session: ConsoleSession): ReactNode }) {
  const { message } = AntApp.useApp();
  const lifetime = useLifetime();
  const [user, setUser] = useState<Principal | null>(null),
    [initialized, setInitialized] = useState<boolean | null>(null),
    [authReady, setAuthReady] = useState(false),
    [authError, setAuthError] = useState(""),
    [authBusy, setAuthBusy] = useState(false);
  useEffect(() => {
    const signal = lifetime();
    void (async () => {
      try {
        const status = await unwrap(api.getSetupStatus({ signal }));
        if (signal.aborted) return;
        setInitialized(status.initialized);
        if (status.initialized) {
          const result = await api.getCurrentUser({ signal });
          if (!signal.aborted) setUser(result.data ?? null);
        }
      } catch (error) {
        if (!signal.aborted) setAuthError(error instanceof Error ? error.message : "无法连接平台");
      } finally {
        if (!signal.aborted) setAuthReady(true);
      }
    })();
  }, [lifetime]);
  async function signIn(values: { username: string; password: string; workspaceName?: string }) {
    const signal = lifetime();
    setAuthBusy(true);
    setAuthError("");
    try {
      const principal = initialized
        ? await unwrap(
            api.login({ signal, body: { username: values.username, password: values.password } }),
          )
        : await unwrap(
            api.setupPlatform({
              signal,
              body: {
                username: values.username,
                password: values.password,
                workspaceName: values.workspaceName ?? "我的组织",
              },
            }),
          );
      if (signal.aborted) return;
      setUser(principal);
      setInitialized(true);
    } catch (e) {
      if (signal.aborted) return;
      setAuthError(e instanceof Error ? e.message : "登录失败");
    } finally {
      if (!signal.aborted) setAuthBusy(false);
    }
  }
  async function logout() {
    try {
      await unwrap(api.logout({ body: {} }));
      setUser(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "退出登录失败");
    }
  }
  if (!authReady)
    return (
      <div className="full-loader">
        <Spin description="连接平台…" />
      </div>
    );
  if (!user)
    return (
      <div className="auth-screen">
        <div className="auth-story">
          <div className="brand">
            <span className="brand-mark">
              <DeploymentUnitOutlined key="DeploymentUnitOutlined" />
            </span>
            <strong>Agent Platform</strong>
          </div>
          <div>
            <div className="eyebrow">企业智能体平台</div>
            <h1>
              让 AI 能力
              <br />
              进入业务日常。
            </h1>
            <p>
              在同一个项目中连接模型、工具与业务应用，
              <br />
              发布 Agent，并追踪每一次执行。
            </p>
            <div className="auth-flow">
              <span>
                <ApiOutlined key="ApiOutlined" /> 模型
              </span>
              <i />
              <span>
                <RobotOutlined key="RobotOutlined" /> Agent
              </span>
              <i />
              <span>
                <ThunderboltOutlined key="ThunderboltOutlined" /> 业务
              </span>
            </div>
          </div>
          <small>集中管理 · 独立运行 · 按版本发布</small>
        </div>
        <div className="auth-panel">
          <div className="auth-form">
            <span className="eyebrow">{initialized ? "欢迎回来" : "开始使用"}</span>
            <h2>{initialized ? "登录工作空间" : "初始化你的平台"}</h2>
            <p>
              {initialized
                ? "登录后继续管理你的 Agent 和业务项目。"
                : "创建组织与首位管理员，然后接入自己的模型服务。"}
            </p>
            {authError && <Alert type="error" title={authError} className="form-alert" />}
            <Form layout="vertical" onFinish={signIn} requiredMark={false}>
              {!initialized && (
                <Form.Item
                  name="workspaceName"
                  label="组织名称"
                  rules={[{ required: true, message: "请输入组织名称" }]}
                >
                  <Input size="large" placeholder="你的团队或组织" />
                </Form.Item>
              )}
              <Form.Item
                name="username"
                label="账号"
                rules={[
                  { required: true, message: "请输入账号" },
                  {
                    pattern: /^[a-zA-Z0-9_-]{3,50}$/,
                    message: "使用 3–50 位字母、数字、下划线或连字符",
                  },
                ]}
              >
                <Input size="large" autoComplete="username" placeholder="输入账号" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码"
                rules={[
                  { required: true, message: "请输入密码" },
                  { min: 12, message: "密码至少 12 位" },
                ]}
              >
                <Input.Password
                  size="large"
                  autoComplete={initialized ? "current-password" : "new-password"}
                  placeholder="至少 12 位"
                />
              </Form.Item>
              <Button block type="primary" htmlType="submit" size="large" loading={authBusy}>
                {initialized ? "登录" : "创建并进入平台"}
                <ArrowRightOutlined key="ArrowRightOutlined" />
              </Button>
            </Form>
            <p className="auth-hint">当前提供本地帐号登录，统一身份中心接入将在后续交付。</p>
          </div>
        </div>
      </div>
    );
  return children({ user, logout });
}
