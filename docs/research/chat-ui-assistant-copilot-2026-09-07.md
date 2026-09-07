# Chat UI 核查：assistant-ui 与 CopilotKit

核查日期：2026-09-07。依据当前官方文档，未安装依赖、未运行集成；版本和恢复行为仍需原型验收。

## 对本项目的结论

**独立聊天产品、可嵌入 UI SDK、平台自己管理会话与客户数据，优先评估 assistant-ui；需要 Agent 深度操纵业务页面、共享应用状态、丰富生成式 UI 时，CopilotKit 更值得投入。** 两者均能与 Mastra 集成。不能把 assistant-ui 等同于纯气泡组件，也不能把 CopilotKit 说成必须使用公有云。[assistant-ui 架构](https://www.assistant-ui.com/docs/architecture)、[CopilotKit OSS 边界](https://docs.copilotkit.ai/claude-sdk-typescript/concepts/oss-vs-enterprise)

## 接入与协议边界

assistant-ui 的官方 Mastra 路径是：Mastra `@mastra/ai-sdk` 的 `chatRoute()` 输出 AI SDK 兼容消息流，浏览器 `@assistant-ui/ai-sdk` 的 `useChatRuntime` 消费。没有专门的 `@assistant-ui/react-mastra` 包。其 runtime 指**浏览器中的聊天状态、流和工具交互管理**，不是客户侧 Agent 执行服务；独立 Mastra 服务已经可以承担聊天端点，无需 assistant-ui 自己的后端或云。[Mastra 集成](https://mastra.ai/integrations/agentic-ui/assistant-ui)、[独立服务指南](https://www.assistant-ui.com/docs/integrations/frameworks/mastra/separate-server)

assistant-ui 目前也有 `@assistant-ui/react-ag-ui`，通过 `HttpAgent` 处理 AG-UI 事件、消息重建、人工介入。因此 **AG-UI 并非选用 CopilotKit UI 的前提绑定**；未来平台可独立决定是否暴露 AG-UI。[AG-UI 适配器](https://www.assistant-ui.com/docs/runtimes/ag-ui/overview)

CopilotKit 的 Mastra 路径是 `@ag-ui/mastra`。Mastra 文档提供 `registerCopilotKit()` 直接挂载端点；CopilotKit 当前文档另有 Copilot Runtime 端点通过 `MastraAgent.getRemoteAgents()` 访问独立 Mastra 服务的方式。Copilot Runtime 是**服务端通信、路由、中间件层**，可嵌入现有后端，并不替代 Mastra 工作流执行，也不必独立部署。生产选型应采用受支持的服务端路径；文档将浏览器直连 AG-UI 的特殊配置定位于开发验证。[Mastra 集成](https://mastra.ai/integrations/agentic-ui/copilotkit)、[Copilot Runtime](https://docs.copilotkit.ai/mastra/copilot-runtime)

## 功能真正由谁承担

| 能力 | assistant-ui | CopilotKit |
| --- | --- | --- |
| 流式消息与工具状态 | 客户端 runtime 管理，支持自定义工具渲染 | AG-UI 驱动聊天、工具、Agent 状态和页面交互 |
| 人工批准 | AI SDK 路径提供审批渲染与响应；AG-UI 支持 interrupt | Mastra 集成提供 `useHumanInTheLoop` 与 `respond` |
| 附件 | 输入、展示和自定义上传 adapter；默认内存 data URL 不宜承担大文档入库 | 当前 UI 有 attachments 配置；模型/适配器负责多模态处理 |
| 来源引用 | 有 Sources 能力；知识库引用的文档、页码和权限仍需后端供给 | 本轮未确认统一知识库引用组件，应按自定义工具/消息渲染评估 |
| 历史会话 | 自定义 history/thread-list adapter 或可选 Assistant Cloud | OSS 自管会话可行；完整 Rich Threads 属于 Intelligence |

以上分别依据 [assistant-ui 能力](https://www.assistant-ui.com/)、[附件](https://www.assistant-ui.com/docs/guides/attachments)、[AI SDK 集成与审批](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7)、[CopilotKit Mastra 人工介入](https://mastra.ai/integrations/agentic-ui/copilotkit)、[CopilotKit UI 示例](https://docs.copilotkit.ai/mastra/custom-look-and-feel/css)。UI 有“批准”按钮不代表已实现授权、审计、幂等和重启恢复，这些仍须由平台及 Mastra 执行侧闭环。

历史是影响本项目最明显的差异。assistant-ui 允许接自己的存储；AI SDK history adapter 必须实现 `withFormat`，以保留 UIMessage 格式。CopilotKit OSS 可自行维护 threadId、框架持久化、会话列表及消息恢复，但官方明确没有可替换的 Rich Threads 后端接口；仅恢复框架状态不等同于恢复完整 AG-UI 事件及生成式界面。[assistant-ui 持久化](https://www.assistant-ui.com/docs/runtimes/concepts/adapters)、[CopilotKit 自管持久化](https://docs.copilotkit.ai/mastra/threads-self-managed)

CopilotKit Intelligence 是可选生产平台，提供完整会话、事件回放和同步。可使用其云，也可在自身网络部署；后者当前需要 Team self-hosted 或 Enterprise 许可，并维护 Kubernetes、Postgres、Redis、OIDC 等。**这不是基本聊天的必需依赖，但若采用其完整 Rich Threads，必须纳入产品与运维成本。**[Intelligence 边界](https://docs.copilotkit.ai/intelligence/overview)、[自托管要求](https://docs.copilotkit.ai/mastra/intelligence/self-hosting)

## React、antd 与嵌入

两者都可进入 React + Vite；官方例子偏 Next.js 不代表需要迁移项目。assistant-ui 提供低层组合组件，默认安装的 UI 多采用 shadcn/Base UI 或 Radix，可改为 antd 外观，但这是适配工作。CopilotKit 提供完整聊天/侧栏/浮层及 CSS 定制；需要重新构造界面时应核实当前高级 headless 功能的许可边界。[assistant-ui Vite 支持](https://www.assistant-ui.com/docs/tools/defining-tools)、[CopilotKit 官方框架识别](https://github.com/CopilotKit/skills/blob/main/skills/copilotkit-setup/SKILL.md)、[预置组件](https://docs.copilotkit.ai/mastra/prebuilt-components)

工程判断：均可封装为平台 npm UI 包；iframe 则由平台提供独立嵌入页面，并建立登录交换、主题、尺寸和消息桥接契约。本轮未发现“安装即可获得企业 iframe 接入治理”的依据。Hey API 生成 REST SDK 与聊天流客户端分层；不能期待 OpenAPI 生成器自动实现 UIMessage/AG-UI 状态归并。客户私网连接与数据路由也不由这两个库解决。

## 版本与原型关注点

当前 assistant-ui 主 AI SDK 文档要求 `ai@^7`、`@ai-sdk/react@^4`，包为 `@assistant-ui/ai-sdk`；v6 另有 legacy 页面，部分 Mastra 集成页仍提 v6，应锁定兼容组合，不能混抄。AG-UI adapter 文档要求 React 18/19。CopilotKit quickstart 要求 Node 20+；当前 runtime 文档混有 v2 子路径和旧 Provider，REST handler 配合 `<CopilotKit>` 时明确要求 `useSingleEndpoint={false}`。[版本说明](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7)、[CopilotKit quickstart](https://docs.copilotkit.ai/mastra/quickstart)、[传输配对](https://docs.copilotkit.ai/mastra/copilot-runtime)

建议用相同 Mastra Agent 验证：流式工具卡片、审批后继续、上传并引用私网文档、刷新恢复消息和待审批状态、租户会话隔离，以及 npm/iframe 两种嵌入。对本项目先做 assistant-ui 原型最有价值；只有明确需要页面状态联动和前端动作时，再让 CopilotKit 进入同规模验证。
