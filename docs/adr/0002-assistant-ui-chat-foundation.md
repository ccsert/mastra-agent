---
status: accepted
date: 2026-09-07
---

# assistant-ui 作为聊天交互与 UI SDK 的基础

用户已确认以 assistant-ui 为 Chat UI 主线。平台需要复用聊天行为，并向不同业务系统交付 React UI SDK 和 iframe；assistant-ui 的无样式 primitives 与聊天 runtime 能承载这些交互，其官方 Mastra 集成也可减少协议适配工作。管理界面仍可使用 Ant Design 6，聊天外观由平台组件与主题实现。

## 集成边界

- 采用 assistant-ui primitives 与官方 AI SDK runtime 集成路径；Mastra 通过 `@mastra/ai-sdk` 的 `chatRoute()` 等接口提供兼容消息流。保持 React + Vite 前端与独立 Mastra 执行服务的部署边界。
- assistant-ui 的 runtime 管理浏览器中的聊天状态、输入、消息和交互；选定的平台托管或客户私有 Mastra Runtime 负责 Agent/Workflow 执行。前端对话状态由这一条集成路径统一管理。
- assistant-ui 的 Elements 是带样式的组合组件，Primitives 是无样式的基础组件。本项目以 primitives 构建自己的聊天 UI；无头能力不代表产品布局、主题和业务卡片无需实现。
- 使用平台自己的会话、历史、上传和身份服务，并通过相应 adapters 连接。平台可保存业务内容，也支持客户私有存储；平台内与业务系统嵌入均可使用这些能力。Assistant Cloud 不作为必要依赖；具体放置、授权与私网访问路径仍待确定。
- 平台内聊天、FlowGram 编排助手、React UI SDK 和 iframe 页面复用聊天组件；对外接口暴露平台配置与业务事件，避免将内部 runtime 对象作为公共接口。
- 按既定要求，平台 API 的请求方法和类型从 OpenAPI 生成；聊天流采用成熟官方适配与协议客户端。消息映射和交互逻辑属于 UI 层。

## 待验证

锁定 Mastra、`@mastra/ai-sdk`、assistant-ui 与 AI SDK 的兼容版本，验证流式消息、并行工具、审批恢复、知识引用、历史恢复及两种嵌入。官方示例采用 Next.js 的部分需按 Vite 配置调整；文档链路核实不等于集成已运行通过。

依据：[无样式 primitives](https://www.assistant-ui.com/docs/primitives)、[架构与状态边界](https://www.assistant-ui.com/docs/architecture)、[Mastra 官方集成](https://mastra.ai/integrations/agentic-ui/assistant-ui)、[assistant-ui 独立服务集成](https://www.assistant-ui.com/docs/integrations/frameworks/mastra/separate-server)。
