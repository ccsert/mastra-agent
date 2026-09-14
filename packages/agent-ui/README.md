# Agent 应用 SDK（0.1）

框架无关的应用协作运行时。目前为本仓库 workspace 包，尚未发布到 npm。可用于原生 JavaScript、React、Vue 等应用，组件库不属于协议。

完整接入说明见 [应用接入指南](../../docs/development/agent-application-sdk.md)，可运行示例见 [原生 JavaScript 订单应用](../../apps/agent-ui-example)。

- `createAgentApplication`：绑定 manifest、observe 和业务动作 handler，验证输入输出、页面版本、草稿授权与请求幂等。
- `serveAgentApplication`：应用侧接收明确 origin/source/channel 的 iframe 通信，检查用户授权与可见性，提供短租约和停止。
- `connectAgentFrame`：宿主连接一个明确选择的页面实例，核对登记 manifest，发送请求并等待真实回执。

仅支持 `read`、`view`、`draft`。SDK 不执行任意脚本、不抓取 DOM、不提供保存/提交工具，不向应用发送平台凭据。第三方应用保持自身登录、授权与业务校验。
