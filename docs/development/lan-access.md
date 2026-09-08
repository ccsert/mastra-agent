# 局域网入口验收

2026-09-08。控制台的开发与构建预览入口统一由 `CONSOLE_HOST` 控制，默认 `0.0.0.0:5179`。浏览器通过同一入口访问页面、API 和事件流，Control plane / Runtime 默认继续在本机监听。

## 修复

- 移除开发脚本和预览命令中固定的 `127.0.0.1`，Vite dev/preview 共用 host、port 和代理配置。
- 启动器把本机当前 IPv4 地址对应的精确控制台 Origin 传给控制面。保留原有 `CONSOLE_ORIGIN`，支持额外明确配置，未放开任意来源。地址变化后重启平台；域名入口还需在 Vite `allowedHosts` 中显式登记域名。
- 工作流插入、复制、AI 编排和执行请求 ID 改用 `uuid`，在 HTTP 局域网环境下使用 `crypto.getRandomValues` 回退。
- OpenAPI 的服务器地址使用 `/`，重新通过 Hey API 生成 SDK，消除文档及默认客户端中的固定本机 API 地址。

依据：[Vite 监听与主机配置](https://vite.dev/config/server-options)、[MDN randomUUID 安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)，以及当前锁定 `uuid@11.1.1` 的浏览器实现。

## 结果

- 实际启动时网卡已从 `192.168.110.151` 切换到 `192.168.50.31`，启动器识别并允许新地址。确认监听 `*:5179`，控制面与 Runtime 分别监听 `127.0.0.1:4110/4112`。
- 从 `http://192.168.50.31:5179` 读取页面、认证状态、OpenAPI 均返回 200；后端健康检查正常。当前主机系统防火墙未启用，本轮未更改防火墙。
- 通过 CUA 在 Edge 中使用局域网地址登录原账号、读取项目和 Runtime 状态；新建“局域网访问验收”，添加与复制节点成功，撤销临时节点后保存基础流程至修订 2。完整刷新后登录会话保持，重新打开可读取已保存草稿，未发布或执行业务流程。
- HTTP 集成与编辑器回归 4/4 通过：包含原本机与额外地址登录、Cookie 属性、非允许来源与错误端口拒绝、OpenAPI 相对地址，以及 SDK → Control plane → Runtime → Mastra 执行链。
- `pnpm build`（含类型检查）、`pnpm lint`、`pnpm sdk:check`、`git diff --check` 通过。构建仍有既有大包提示。

浏览器与 HTTP 请求使用了主机的实际局域网地址；本轮未从另一台物理电脑验证交换机、无线隔离或路由策略。
