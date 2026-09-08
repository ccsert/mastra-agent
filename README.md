# 企业 Agent 平台

面向业务团队的 Agent、知识库、工具/MCP、标准 Agent Skills 和 AI 工作流平台。目标支持平台内使用，以及 OpenAPI、生成 SDK、React 组件与 iframe 接入；集中控制面管理平台托管和客户私有 Runtime。

**当前交付 M4：AI 工作流编排与执行。** 在真实模型、知识库和 MCP Agent 闭环上，增加正式 FlowGram 画布、AI 完整候选与修订冲突检查、固定发布版本，以及 Mastra 串行/条件执行。平台和生成 SDK 均已使用真实 Qwen 验证订单采购报告；Skills、私网连接与嵌入组件尚未接入正式平台。

## 本地启动

需要 Node.js 24.13+、pnpm 10.32.1、Docker Compose。当前 Compose 提供 PostgreSQL，三个应用进程在主机运行。

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d --build --wait postgres
pnpm db:migrate
pnpm dev
```

打开 [控制台](http://127.0.0.1:5179)，首次进入创建组织与管理员，然后按工作台引导接入模型、登记工具、创建并发布 Agent。控制面位于 `127.0.0.1:4110`；独立 Runtime 的健康端口为 `4112`，主动通过 HTTP 领取任务。

`setup:local` 生成 `.env` 与只包含 Runtime 设置的 `.env.runtime`，均不会覆盖已有文件。配置与本地数据不提交到 Git。需要保留 PostgreSQL 数据卷与 `ENCRYPTION_KEY` 才能恢复加密凭据。普通停止用 `docker compose stop`，不要删除数据卷。

### 局域网访问

`pnpm dev` 与 `pnpm preview` 默认在 `0.0.0.0:5179` 提供控制台，启动日志打印本机访问地址。其他电脑使用 `http://服务器的局域网IP:5179`，并使用已有账号登录。页面、API 和会话流均通过同一个 5179 入口；API 进程和 Runtime 默认仍监听本机，由控制台代理 API 请求。

启动器自动将本机当前 IPv4 地址对应的控制台来源加入登录与写入允许列表，同时保留 `CONSOLE_ORIGIN`。IP 地址变化后重启 `pnpm dev` / `pnpm preview`。`.env` 中可设置 `CONSOLE_HOST=127.0.0.1` 改为仅本机监听，或通过 `CONSOLE_ADDITIONAL_ORIGINS` 添加逗号分隔的精确访问来源；直接启动控制面时也需明确配置这些来源。其他机器的浏览器通过服务器地址访问即可，不需要把客户端 IP 加入允许列表。

HTTP 局域网环境的工作流 ID 使用支持 `crypto.getRandomValues` 回退的 UUID 实现，覆盖插入/复制节点、AI 编排和发起工作流。OpenAPI 使用相对服务器地址 `/`，可从当前访问入口调用。生产部署继续使用 HTTPS 和 `COOKIE_SECURE=true`。

## 模型与验收

模型管理支持对话、向量和重排。对话采用 OpenAI 兼容 Chat Completions：在「模型服务」填写 Base URL、模型 ID 和 API Key；密钥加密保存，创建 Agent 时绑定模型。通过对话验证流式响应和模型的工具调用兼容性。

没有模型时，可以单独启动 `pnpm fixture`：Base URL 为 `http://127.0.0.1:4199/v1`，模型 ID 为 `protocol-fixture`，测试凭据为 `fixture-key`。请命名为“协议测试服务”，并绑定内置 `sum_values` 工具。**这是确定性 HTTP 协议验收服务，不做真实 LLM 推理。** M2 另使用真实 Qwen 服务完成了对话、工具调用、1024 维文档入库、重排和带来源回答的合成样例验收。

本次开发环境的账号信息保存在忽略的 `.local/dev-access.md`；该文件只在此次页面验收中生成，新安装自行初始化。

## 验证与 SDK

统一检查入口为 `pnpm check`，依次检查代码规范、模块依赖、类型与构建、生成 SDK 一致性、后端/领域测试及 React 组件回归。依赖检查阻止跨应用源码引用、循环依赖和 Runtime 数据库依赖；详细问题与本轮边界见 [工程质量审查](docs/development/engineering-quality.md)。需要单独调试时使用下列命令，前端组件回归使用 `pnpm test:console`。

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm sdk:check
```

若要查看构建产物，停止 `pnpm dev` 后执行 `pnpm preview`，控制台仍位于 5179。

测试使用独立 PostgreSQL schema，结束后清理测试 schema。覆盖生成 SDK 到 Mastra 工具执行、隔离/鉴权、发布固定、幂等、取消、失败与租约、消息流竞态。知识库测试另覆盖多批分段、维度传递、重排、删除、隔离和锁等待跨租约截止。工作流测试另覆盖互斥分支、上游变量、候选原样返回后的重试、旧版本调用和节点事件；本轮验收见 [M4 记录](docs/development/m4.md)。

SDK 请求与类型由 Hey API 从 OpenAPI 生成；`pnpm sdk:generate` 更新契约和代码，`pnpm sdk:build` 输出 JS 与类型声明。`pnpm --dir packages/sdk pack --out ../../.local/platform-sdk.tgz` 生成可安装包，使用方法见 [SDK 文档](packages/sdk/README.md)。应用 AK/SK 仅用于业务后端。

## 工程与后续主线

| 目录 | 职责 |
| --- | --- |
| `apps/console` | React + Vite + AntD 6 控制台，assistant-ui 聊天 |
| `apps/control-plane` | Hono API、用户/应用身份、资源/发布、会话、任务与 PostgreSQL |
| `apps/runtime` | 独立 Mastra Agent 执行进程，无数据库依赖或数据库凭据 |
| `packages/contracts` | Zod 领域契约和导出的 OpenAPI |
| `packages/database` | PostgreSQL 连接、迁移和事务 |
| `packages/sdk` | Hey API 生成 SDK、服务端签名辅助函数及分发产物 |

后续继续接入更多文档格式与可视化处理流程、标准 Skills 包及隔离执行、更丰富的工作流结构、私网 Runtime/连接器和嵌入组件。统一身份中心、细粒度成员权限、内容治理、生产部署与容量验收继续按既定决策推进。当前是开发里程碑，尚未完成企业级生产验收。

已有方案：[领域术语](CONTEXT.md)、[架构草案](docs/planning/agent-platform-discovery.md)、[FlowGram/Mastra ADR](docs/adr/0001-flowgram-authoring-mastra-execution.md)、[assistant-ui ADR](docs/adr/0002-assistant-ui-chat-foundation.md)。

已有技术证据：[Skill 隔离原型](docs/research/skill-sandbox-prototype-2026-09-07.md)、[工作流持久化](docs/research/workflow-persistence-probe-2026-09-07.md)、[发布契约](docs/research/release-contract-probe-2026-09-07.md)、[FlowGram 往返](docs/research/flowgram-roundtrip-probe-2026-09-07.md)。原实验工作区保留在 `.scratch/`，正式平台与它们独立启动。

知识库使用与升级说明见 [M2 开发验收](docs/development/m2.md)。向量模型可配置 `dimensions`，绑定知识库后入库和查询使用同一模型及维度。

MCP 使用与边界见 [M3 开发验收](docs/development/m3.md)。在「MCP 服务」登记 Streamable HTTP 地址，发现能力并审阅导入后，到 Agent 编辑页绑定工具并发布。`pnpm fixture:mcp` 启动合成订单样例，地址 `http://127.0.0.1:4201/mcp`，测试凭据 `mcp-fixture-key`，订单号 `ORD-1001`；该服务没有真实业务数据，也不会执行写入。

工作流使用与边界见 [M4 开发验收](docs/development/m4.md)。在「工作流」创建草稿，用自然语言生成完整候选、审阅差异并接受，校验发布后运行。当前提供开始、结束、Agent、工具、变量映射和互斥条件分支；项目「企业知识助手」已有「订单采购报告」v1/v2 样例。
