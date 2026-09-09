# 局域网入口验收

2026-09-08。控制台的开发与构建预览入口统一由 `CONSOLE_HOST` 控制，默认 `0.0.0.0:5179`。浏览器通过同一入口访问页面、API 和事件流，Control plane / Runtime 默认继续在本机监听。

## 修复

- 移除开发脚本和预览命令中固定的 `127.0.0.1`，Vite dev/preview 共用 host、port 和代理配置。
- `pnpm dev/preview` 启动器启用 `CONSOLE_LOCAL_ORIGINS=true`，控制面在请求时读取本机当前 IPv4 地址，并按控制台协议、端口进行精确 Origin 校验。切换网络后新地址自动生效，旧网卡地址自动移除，无需重启。保留原有 `CONSOLE_ORIGIN` 和 `CONSOLE_ADDITIONAL_ORIGINS` 的显式配置；单独启动控制面默认只信任显式来源。域名入口还需在 Vite `allowedHosts` 中显式登记域名。
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

## 2026-09-09 网络切换后登录来源拒绝

- 复现：机器已切换到 `192.168.110.151`，运行中的控制面仍持有启动时的 `192.168.50.31` 来源列表。通过实际登录表单请求 `/api/v1/auth/login` 返回 403 `ORIGIN_DENIED`。
- 修复：启动器只开启本机来源动态发现，不再把网卡地址固化到额外来源变量；控制面每次校验时读取当前网卡，继续精确匹配协议、主机和端口。显式配置的来源不随网卡变化删除。
- 已重启本地预览服务，在 `http://192.168.110.151:5179/` 使用已有账号登录返回 200。完整刷新后会话保持，工作台与 Runtime 已连接状态正常，刷新后无浏览器异常或失败 HTTP 请求。截图：`.local/lan-origin-login-20260909.png`。
- 实际 HTTP 回归确认：旧地址、同网段其他主机、错误端口、错误协议、域名后缀伪装与 `null` 来源均返回 403。健康检查返回 200。
- `tests/console-origins.test.ts` 与 `tests/integration.test.ts` 共 3 项通过，覆盖运行期间替换来源后的登录、会话读取与拒绝规则。本次改动最初的定向 Biome 与架构检查通过；排除并行新增的 `tests/pagination.test.ts` 后类型检查通过。完整工作区检查仍受并行分页测试的隐式类型错误及后续日志/启动代码格式改动影响，不作为本次全量通过证据。
