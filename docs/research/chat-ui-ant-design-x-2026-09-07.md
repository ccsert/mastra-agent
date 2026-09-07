# Ant Design X 聊天界面研究

本文件保留选型前的专项比较。当前用户已选择 assistant-ui，实施以 [ADR](../adr/0002-assistant-ui-chat-foundation.md) 为准。

核查时间：2026-09-07 11:51–11:55（Asia/Shanghai）。仅核查官方文档、官方源码和 npm registry；没有安装依赖、构建或浏览器验收。

## 建议

**Ant Design X 适合作为平台 Chat UI 的首选视觉基础。** 它与 antd 6 的组件、主题机制一致，覆盖消息、输入、附件、引用和执行过程展示。建议封装成自己的 React UI SDK，并以同一组件构建 iframe 页面。`x-sdk` 是可选的前端会话状态/请求层，不能直接等同于平台对外 API SDK，也不是 Mastra Runtime。此处为结合项目需求的架构判断。

## 当前兼容性

以下是 npm 官方 registry 于 2026-09-07 03:51 UTC 返回的 `latest` 元数据，不等同于安装验证。三个 X 包均在 2026-07-28 发布 2.9.0。

| 包 | 版本 | peerDependencies | 许可 |
| --- | --- | --- | --- |
| `@ant-design/x` | 2.9.0 | antd `^6.1.1`；React/ReactDOM `>=18.0.0` | MIT |
| `@ant-design/x-sdk` | 2.9.0 | React/ReactDOM `>=18.0.0` | MIT |
| `@ant-design/x-markdown` | 2.9.0 | React/ReactDOM `>=18.0.0` | MIT |

三个包均提供 `es/index.js` 和 `lib/index.js`；官方另有 Vite 接入教程。因此 React + Vite + antd 6.1.1 以上具备文档和元数据支持，React 18/19 的实际构建及嵌入兼容仍待验证。[x 元数据](https://registry.npmjs.org/@ant-design/x/latest)、[x-sdk 元数据](https://registry.npmjs.org/@ant-design/x-sdk/latest)、[x-markdown 元数据](https://registry.npmjs.org/@ant-design/x-markdown/latest)、[Vite 指南](https://x.ant.design/docs/react/use-with-vite/)

## 现成能力与平台职责

| 需求 | 可复用能力 | 平台仍需实现 |
| --- | --- | --- |
| 消息与会话 | Bubble、Sender、Conversations；useXChat 消息状态、取消、重新生成、历史初始化；useXConversations 会话列表 | 服务端持久化、分页、权限、审计、刷新后运行关联 |
| 流式输出 | XRequest、XStream、自定义 Provider；x-markdown 处理流式 Markdown 和组件替换 | Mastra 事件映射、事件 ID、去重、断线续传与取消执行语义 |
| 附件 | Attachments 继承 antd Upload，可拖放和显示上传状态 | 私网文件存储、授权、文档解析及知识库入库生命周期 |
| 知识引用 | Sources 支持列表、行内引用和点击事件 | 文档/页码/段落定位、引用可信度、访问授权 |
| 工具与进度 | ThoughtChain 显示工具调用链、状态、可折叠内容，可组合自定义卡片 | 工具输入输出模型、敏感字段过滤、工具与工作流步骤关联 |
| 人工审批 | 可用自定义卡片和 antd 表单按钮构建 | 审批请求、授权、过期、幂等提交、服务端恢复执行 |

依据：[useXChat](https://x.ant.design/x-sdks/use-x-chat/)、[会话列表](https://x.ant.design/x-sdks/use-x-conversations/)、[XRequest](https://x.ant.design/x-sdks/x-request/)、[Markdown](https://x.ant.design/x-markdowns/introduce/)、[附件](https://x.ant.design/components/attachments/)、[Sources](https://x.ant.design/components/sources/)、[ThoughtChain](https://x.ant.design/components/thought-chain/)。后端职责为根据这些公开 API 边界作出的工程判断；有展示组件不代表已实现相应业务闭环。

## 与 Mastra、Hey API 的分工

官方 Provider 文档支持继承 `AbstractChatProvider`，分别转换请求、用户消息和响应增量，可接入自定义 Agent 服务。本次未发现内置 Mastra Provider。Mastra 官方另有 AI SDK UI 的流转换和路由适配；因此可以选 X SDK 自定义 Provider，也可以仅使用 X 视觉组件、保留 Mastra 对接的另一套消息状态层。**同一会话只应有一个消息状态所有者。** [自定义 Provider](https://x.ant.design/x-sdks/chat-provider-custom/)、[Mastra 官方 AI SDK 适配](https://mastra.ai/blog/ai-sdk-v7-support)

建议传输接口依赖平台定义的会话、运行、工具及审批契约，通过网关抵达客户侧 Runtime；浏览器是否直连私网 Runtime 由部署和数据边界决定。Hey API 从平台 OpenAPI 生成类型与请求函数，适合会话、上传、运行查询、审批提交等；UI SDK 负责渲染及交互。流式事件的业务聚合不会由 OpenAPI 生成器自动完成，本次未验证 Hey API 生成的 SSE 接口与 XRequest 是否可以直接复用，应避免两层同时读取同一个 response body。[Hey API Fetch](https://heyapi.dev/docs/openapi/typescript/clients/fetch)、[SDK 插件](https://heyapi.dev/docs/openapi/typescript/plugins/sdk)

## 嵌入和最小验证

X 的 npm 组件和可配置请求地址允许构建自托管前端，没有要求聊天必须经过 Ant 托管服务。iframe 的短期身份令牌、origin 校验、尺寸通信，以及 React SDK 的主题隔离、依赖 external、宿主 React/antd 版本冲突都需要平台封装。MIT 许可字段已经核实，交付时仍需随发行包保留相应版权与许可。

建议原型只验证：真实 Mastra 流的文本/引用/两个并行工具/审批恢复；切换会话并刷新；断线与取消；文件上传及授权；React 18/19 宿主页与 iframe 各一次；窄屏、长会话、键盘导航和最终打包体积。X 包依赖 Mermaid 与代码高亮库，不能仅凭按需导入就假设嵌入包轻量。

## 轻量备选

`@chatui/core` 当前为 3.8.0（2026-05-26），React/ReactDOM peer 为 `>=16.8.0`，MIT。它有完整 Chat 容器、useMessages、文件/自定义消息、下拉历史和移动安全区能力，可作为偏移动客服聊天的备选。其官网示例将发送请求留给应用，Mastra 接入与 Agent 工具/审批语义同样需要自建；项目已有 antd 主线，暂不建议引入第二套视觉体系。[npm 元数据](https://registry.npmjs.org/@chatui/core/latest)、[Chat API](https://chatui.io/components/chat)、[快速上手](https://chatui.io/components)
