# Agent Platform SDK

请求方法与类型由控制面 OpenAPI 使用 Hey API 生成。`applicationSigner` 是独立的服务端 HMAC 签名辅助函数，不替代生成的请求方法。

```ts
import { createClient } from '@platform/sdk/client';
import { applicationSigner } from '@platform/sdk/auth';
import { createConversation, createRun, getRun } from '@platform/sdk';

const client = createClient({ baseUrl: process.env.PLATFORM_URL });
client.interceptors.request.use(applicationSigner({
  appId: process.env.APP_ID!,
  accessKey: process.env.ACCESS_KEY!,
  secretKey: process.env.SECRET_KEY!,
}));
const path = { projectId: process.env.PROJECT_ID! };
const { data: conversation } = await createConversation({
  client, path, throwOnError: true,
  body: { agentId: process.env.AGENT_ID! },
});
const { data: run } = await createRun({
  client, path, throwOnError: true,
  body: { conversationId: conversation.id, input: '请计算 40 + 80', requestId: crypto.randomUUID() },
});
const { data: status } = await getRun({ client, path: { ...path, id: run.id }, throwOnError: true });
```

`getRun` 查询任务；`listRunEvents({ query: { after } })` 按序号分页读取事件；`cancelRun` 请求取消。每页最多 500 个事件。请求幂等键 `requestId` 在会话内唯一，相同键与输入返回原任务，改变输入返回 409。

AK/SK 仅可用于业务服务端；浏览器使用会话 Cookie。应用只能访问所属项目，自己的会话与平台用户会话分离。SDK 需要支持 Fetch/Web Streams 的运行环境；签名辅助函数需要 Node.js。项目在 Node 24 上验证。

开发构建：仓库根目录执行 `pnpm sdk:generate`、`pnpm sdk:build`。打包：`pnpm --dir packages/sdk pack --out ../../.local/platform-sdk.tgz`。生成目录不手工修改。
