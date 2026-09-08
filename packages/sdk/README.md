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

MCP 管理接口包括 `listMcpServers`、`createMcpServer`、`updateMcpServer`、`listMcpDiscoveries`、`discoverMcpTools` 和 `importMcpTool`，仅限平台用户会话。发现是异步任务，读取发现记录直到成功后才能按 `discoveryId` 审阅导入；`confirmedReadOnly: true` 表达维护者明确确认。业务应用继续通过已发布 Agent 间接调用获准 MCP 工具。

## 已发布工作流

业务服务端以 AK/SK 调用固定 `releaseId`；`id` 是工作流 ID。平台用户可通过生成的管理方法创建/保存草稿、请求 AI 候选、接受并发布。

```ts
import { createWorkflowRun, getWorkflowRun, listWorkflowNodeRuns } from '@platform/sdk';

const { data: run } = await createWorkflowRun({
  client, throwOnError: true,
  path: { projectId, id: workflowId },
  body: { releaseId, input: { orderId: 'ORD-1001' }, requestId: crypto.randomUUID() },
});
const runPath = { projectId, id: run.id };
const { data: result } = await getWorkflowRun({ client, path: runPath, throwOnError: true });
const { data: nodes } = await listWorkflowNodeRuns({ client, path: runPath, throwOnError: true });
```

`getWorkflowRun` 为异步状态读取：在 `queued` / `running` 时继续轮询，终态再读取节点详情。`cancelWorkflowRun` 终止后续执行。节点状态包括成功、失败、取消与未选分支的 `skipped`，包含输入输出；业务输出位于 `result.output`。

`requestId` 在工作流、调用者与入口范围内去重；同一键但版本或输入不同返回 409。应用只能访问自己的运行，不能管理草稿、发布或请求 AI 编排。重试业务调用应由调用方明确决定，平台不会隐式重放失败的节点。

管理方法：`listWorkflows` / `createWorkflow` / `getWorkflow` / `updateWorkflow` / `validateWorkflow` / `publishWorkflow` / `listWorkflowReleases`。`updateWorkflow` 完整替换草稿并要求 `baseRevision`，冲突返回 409。`generateWorkflow` 是异步候选任务，通过 `getWorkflowGeneration` 读取状态与校验问题；`acceptWorkflowGeneration` 只更新草稿，仍需另行发布。接受时要求生成基线与当前草稿修订一致。
