# 企业 Agent 平台

面向业务团队的 Agent、知识库、工具/MCP、标准 Agent Skills 和 AI 工作流平台。目标支持平台内使用，以及 OpenAPI、生成 SDK、React 组件与 iframe 接入；集中控制面管理平台托管和客户私有 Runtime。

**当前交付 M1：可运行的独立 Agent 闭环。** 已有正式前后端和 PostgreSQL 存储，项目、模型、工具、Agent 发布、聊天、运行记录、应用凭据均使用真实接口。知识库、Skills、FlowGram AI 编排、私网连接与嵌入组件尚未接入正式平台，不将研究原型计为已交付功能。

## 本地启动

需要 Node.js 24.13+、pnpm 10.32.1、Docker Compose。当前 Compose 提供 PostgreSQL，三个应用进程在主机运行。

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev
```

打开 [控制台](http://127.0.0.1:5179)，首次进入创建组织与管理员，然后按工作台引导接入模型、登记工具、创建并发布 Agent。控制面位于 `127.0.0.1:4110`；独立 Runtime 的健康端口为 `4112`，主动通过 HTTP 领取任务。

`setup:local` 生成 `.env` 与只包含 Runtime 设置的 `.env.runtime`，均不会覆盖已有文件。配置与本地数据不提交到 Git。需要保留 PostgreSQL 数据卷与 `ENCRYPTION_KEY` 才能恢复加密凭据。普通停止用 `docker compose stop`，不要删除数据卷。

## 模型与验收

支持 OpenAI 兼容 Chat Completions：在「模型服务」填写 Base URL、模型 ID 和 API Key；密钥加密保存，创建 Agent 时绑定模型。通过对话验证流式响应和模型的工具调用兼容性。

没有模型时，可以单独启动 `pnpm fixture`：Base URL 为 `http://127.0.0.1:4199/v1`，模型 ID 为 `protocol-fixture`，测试凭据为 `fixture-key`。请命名为“协议测试服务”，并绑定内置 `sum_values` 工具。**这是确定性 HTTP 协议验收服务，不做真实 LLM 推理。真实模型尚未验收。**

本次开发环境的账号信息保存在忽略的 `.local/dev-access.md`；该文件只在此次页面验收中生成，新安装自行初始化。

## 验证与 SDK

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm sdk:check
```

若要查看构建产物，停止 `pnpm dev` 后执行 `pnpm preview`，控制台仍位于 5179。

测试使用独立 PostgreSQL schema，结束后清理测试 schema。覆盖生成 SDK 到 Mastra 工具执行、隔离/鉴权、发布固定、幂等、取消、失败与租约、消息流竞态。浏览器还需按[验收记录](docs/development/m1.md)复核。

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

后续依次接入知识库与文档流程、标准 Skills 包及隔离执行、FlowGram 与 AI 编排、私网 Runtime/连接器和嵌入组件。统一身份中心、细粒度成员权限、内容治理、生产部署与容量验收继续按既定决策推进。当前是开发里程碑，尚未完成企业级生产验收。

已有方案：[领域术语](CONTEXT.md)、[架构草案](docs/planning/agent-platform-discovery.md)、[FlowGram/Mastra ADR](docs/adr/0001-flowgram-authoring-mastra-execution.md)、[assistant-ui ADR](docs/adr/0002-assistant-ui-chat-foundation.md)。

已有技术证据：[Skill 隔离原型](docs/research/skill-sandbox-prototype-2026-09-07.md)、[工作流持久化](docs/research/workflow-persistence-probe-2026-09-07.md)、[发布契约](docs/research/release-contract-probe-2026-09-07.md)、[FlowGram 往返](docs/research/flowgram-roundtrip-probe-2026-09-07.md)。原实验工作区保留在 `.scratch/`，正式平台与它们独立启动。
