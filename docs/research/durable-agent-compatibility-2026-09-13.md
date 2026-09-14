# Mastra durable Agent 固定版本兼容性实验

日期：2026-09-13。范围：`@mastra/core@1.64.0`、`@mastra/ai-sdk@1.10.1`、`ai@7.0.93`，Node 24.13.0。下文保留最初仅使用 `MockLanguageModelV3` 的独立实验记录；此后平台适配与真实运行状态见 [交付记录](long-task-chat-delivery-2026-09-13.md)，不能把两个阶段的验证范围混合。

后续接入采用公开 `pruneSnapshot` 适配保留运行中前驱输入；工具授权与回执包在真实工具执行体外，避免依赖恢复时丢失的 Agent hooks。远程 storage 保存经过 PNG 字典去重与 gzip 的快照，兼容旧格式，限制压缩与还原体积。依赖补丁只修复 durable 全局缓存中空条目的读取，未采用下文诊断副本的 restart 算法改动。平台回归现覆盖 80 步、真实大 PNG、进程恢复、重复/未知工具回执、预算与取消；这些覆盖仍不代表所有上游 Workflow 节点与故障点都已验证。

## 结论

**普通 durable 多步执行可用，但当前版本默认配置的独立进程 recover 不能直接上线。** 公开 API 导出的运行中快照在新进程恢复时稳定失败；实验定位到 native snapshot pruning 与 default workflow restart 的输入选择不匹配。仅把 storage 换为 PostgreSQL 或远程 RPC 不会修复这个问题，因为裁剪发生在 storage 之前。后续实验证明，通过公开 Workflow options 关闭两层裁剪可以恢复；代价是快照体积增长，且 hooks 缺陷仍在，见下文补充。

另外，诊断性修复快照后恢复能够完成剩余步骤，但新注册 Agent 的 `hooks.beforeToolCall/afterToolCall` 没有触发。鉴权、Skill 约束和轨迹采集不能直接假定这些 hooks 会随 recover 自动恢复。

## 可复现代码和结果

目录：`.scratch/long-task-20260913/durable-probe/`。

- `probe.ts`：完整最小例子。fake model 根据历史中的 tool-result 数量生成下一次工具调用；工具返回确定数值；无网络调用。
- `verify.ts`：依次运行 5 个独立 Node 进程，并验证下表的成功行为和缺陷。
- `*.jsonl`：模型输入、工具执行、hook、AI SDK UI chunk 及完成指标。
- `checkpoint.bin`：V8 序列化的官方公开 workflow snapshot，保留 Date 等类型。
- `checkpoint.json`：便于阅读的同一快照，**不是**恢复数据源。
- `*.process.log`：进程 stdout/stderr。

运行：

```sh
node --import tsx .scratch/long-task-20260913/durable-probe/verify.ts
```

| 场景 | 实测 |
| --- | --- |
| normal | 3 次模型请求、2 个工具，2 次 before / after hooks，3 次 prepareStep，最终 DONE 3 |
| budget | 模型还要求更多工具时，maxSteps=2 正好在 2 次请求、2 个工具后结束 |
| crash | 工具 1 已完成，在模型请求 2 开始处通过公开 listWorkflowRuns 导出两个 running snapshot，然后 process.exit |
| recover | 新进程、新 Mastra、新 Agent、新 InMemoryStore，恢复官方快照后稳定报 `Cannot read properties of undefined (reading 'messages')` |
| recover-repaired | **仅用于缺陷定位**，给 execution 的前驱 output 补回当前 active payload 中仍存在的 messageListState / accumulatedSteps：剩余 2 次模型请求、1 个工具完成，不重复工具 1；但 before/after/prepareStep 均为 0 |

`verify.ts` 的通过意味着成功行为与已知失败均符合断言，**不意味着 native recovery 已通过上线验收**。诊断快照变换不得作为未经全面验证的生产兼容层。

## 最少 storage domains 与平台接入

普通 durable stream 和手动传入完整模型历史只需要 `workflows`，实测使用：

```ts
const backing = new InMemoryStore();
const workflows = await backing.getStore('workflows');
const storage = new MastraCompositeStore({
  id: 'runtime-remote-storage',
  domains: { workflows },
});
new Mastra({ agents: { agent }, storage });
```

这里没有注册 memory、observability、editor 等其他 domain。`InMemoryStore` 只为实验提供官方的 domain 实现；平台可用 `WorkflowsStorage` 子类把调用转发给 ControlPlane 中的官方 PostgreSQL adapter，Runtime 不需要数据库驱动。此结论为公开接口与实际 workflows-only 执行共同支持；本实验没有实现或验证 HTTP transport。

`WorkflowsStorage` 需要以下方法，不是仅 load/save 两个快照方法：

| 方法 | 接入要点 |
| --- | --- |
| supportsConcurrentUpdates | 同步能力声明，不能返回 RPC Promise，必须匹配服务器真实实现 |
| updateWorkflowResults | 服务端使用官方原子合并语义；不要在 Runtime 做远程 read-modify-write |
| updateWorkflowState | 同上，保留原生 opts 语义 |
| persistWorkflowSnapshot / loadWorkflowSnapshot | 保留全部当前版本需要的字段和必要的日期类型 |
| listWorkflowRuns | 保留 workflowName/status/resourceId/date/pagination 过滤 |
| getWorkflowRunById / deleteWorkflowRunById | workflowName 与 runId 联合限定；完成后原生会删除 loop/execution 快照 |
| dangerouslyClearAll | Runtime RPC 不应开放，明确拒绝；init 可委托服务端预先完成 |

加上原生 Memory 时需要 `memory` domain。原生 goal 的 `setObjective/getObjective` 实际存储为 `threadState` domain（`getState/setState/deleteState`），缺少时 setObjective 可以静默 no-op。`@mastra/memory@1.29.0` 的 knowledge/pinned/subconscious 能力还使用 `knowledge` domain；向量检索另外要求 vector/embedder。后面三项是固定版本代码审阅，**未在本实验实跑**。

来源：[WorkflowsStorage 接口](../../apps/runtime/node_modules/@mastra/core/dist/storage/domains/workflows/base.d.ts)、[MastraCompositeStore 接口](../../apps/runtime/node_modules/@mastra/core/dist/storage/base.d.ts)、[native goal store resolver](../../apps/runtime/node_modules/@mastra/core/dist/task-state-processor-BQwvY7TE.js)、[Memory 实现](../../apps/runtime/node_modules/@mastra/memory/dist/src-BNB8ko_o.js)。这些链接随依赖重新安装可能变化，精确版本以上述依赖版本为准。

## 恢复缺陷的具体位置

原生创建两个 workflow：`durable-agentic-loop`、`durable-agentic-execution`，两者 runId 相同。恢复要保存二者，不能只持久化顶层 row。

实验退出时 execution 的 active path 是 `durable-llm-execution`，其 payload 仍有完整 messageListState；但前驱 `map-to-llm-input` 已完成，其 output 中的 messageListState 被 `pruneRunningHistory` 删除。`restart()` 恢复输入来自前驱 output，随后 `resolveRuntimeDependencies()` 执行 `messageList.deserialize(input.messageListState)` 失败。

外层 `init-iteration-state` 的 output 也被裁剪，但 loop 的执行路径已经读保存的 active payload，因此进一步收窄后仅补 execution 的 `map-to-llm-input.output` 就能成功。因此不是 JSON 丢 Date、缺少 memory domain、假模型丢 provider 或没有保存子 workflow。

来源：[pruneAgentLoopSnapshot / pruneRunningHistory](../../apps/runtime/node_modules/@mastra/core/dist/agent-DsRUDsS_.js)、[recover / resolveRuntimeDependencies](../../apps/runtime/node_modules/@mastra/core/dist/create-durable-agent-76UE00WE.js)，及 `checkpoint.json`、`recover.process.log`。

## 流、历史、hooks 和预算

- `Agent({durable:true})` 注册到 Mastra 后，stream/recover 返回 `{output, fullStream, runId, cleanup, abort}`，转换要传 `toAISdkStream(result.output, {from:'agent', version:'v7'})`，不能把 wrapper 当 MastraModelOutput。
- 正常流 UI chunks 包含完整两个工具与最终文本；恢复流只有恢复段，在本实验没有重新输出 `start`，也没有重播工具 1。平台必须保留已有事件并对恢复段做稳定消息合并，不能当成完整消息替换。
- 恢复后的模型输入包含原用户 marker `violet-317` 和已完成工具 1 的结果；工具 1 没有重执行。这是诊断修复场景的实测，原版 recover 仍失败。
- `output.steps` / `output.usage` 的恢复对象只反映新 stream 段。原始平台事件与用量应持久化并按 step 身份汇总，不以恢复段值覆盖整个 run。
- 普通流实验的 `output.response.dbMessages` 只带第一个工具消息，未覆盖最终文本；UI chunks 与模型 prompt 才呈现完整本次交互。平台应沿用 native `readUIMessageStream` 从实际完整 UI 事件形成对话记录，并给该路径补实际多步验收，不能盲用 response.dbMessages 替换平台历史。
- stream 的 `maxSteps` 是可序列化预算，实测有效。`stopWhen`、`prepareStep`、调用时 callbacks 属于闭包，不会跨进程持久化；recover 只可重新提供其公开 options 中列出的 callbacks/abortSignal。
- 更严重的是，诊断恢复时同样重新注册的 Agent-level tool hooks 也未调用。工具鉴权应由可重新构建的工具本体包装保障，并额外验证失败、跳过、Skill 和子代理路径；这个实验不证明当前生产 hooks 可直接兼容 durable。

来源：[Durable stream/recover 类型](../../apps/runtime/node_modules/@mastra/core/dist/agent/durable/durable-agent.d.ts)、[AI SDK 7 adapter 类型](../../apps/runtime/node_modules/@mastra/ai-sdk/dist/convert-streams.d.ts)、`normal.jsonl` 和 `recover-repaired.jsonl`。

## 租约与互斥

必须纠正“原生没有 recover lease”的笼统描述：1.64.0 的 recover 已有 `acquireRecoveryLease`、续约、丢租约 abort 和 fenced pubsub。其能力来自 **PubSub LeaseProvider**，不是 workflows store。默认 EventEmitterPubSub 的 lease 是进程内 Map；不实现 LeaseProvider 的自定义 pubsub 则降级 NoopLeaseProvider。只共享 PostgreSQL workflows storage 不构成跨进程互斥。

`recoverActiveRuns` 当前委托 `recover`，保留相同 lease 语义；它消费/丢弃各 run 的流并等待 settlement，适合批量恢复结果，不直接给平台持续轨迹。平台主动跟踪单 run 时应使用 recover 并采集其 output。

来源：[recover lease 实现](../../apps/runtime/node_modules/@mastra/core/dist/create-durable-agent-76UE00WE.js)、[LeaseProvider](../../apps/runtime/node_modules/@mastra/core/dist/events/pubsub.d.ts)、[EventEmitterPubSub](../../apps/runtime/node_modules/@mastra/core/dist/events/event-emitter/index.d.ts)。

## 接入建议

优先把 ControlPlane 官方 storage adapter / typed RPC、执行预算与持久工作区做成可独立验证的能力。durable 开启前增加固定版本兼容 gate：原版 crash/recover、未完成工具 crash/recover、工具幂等、hooks、历史、全程预算，以及双 worker 抢同一 run。应修复或升级上游并通过该 gate；不能把本实验的快照补字段诊断直接装进生产并称为完整 durable 支持。

## 补充实验：公开 options、累计预算、取消、最小上游改动

以下在同一固定版本上追加实跑，仍无真实模型和数据库。

### 公开 Workflow options 的规避路径

`AgentDurableOption` 没有直接暴露 `pruneSnapshot`。但注册后的 DurableAgent 提供公开 `getWorkflow()`，Workflow 的公开 `options` getter 返回实际 options，`steps` 也公开可读。下面是已经成功跑通 crash → fresh recover 的最小配置：

```ts
const workflow = registeredDurableAgent.getWorkflow();
workflow.options.pruneSnapshot = ({ snapshot }) => snapshot;
const execution = workflow.steps['durable-agentic-execution'];
// 此 step 为 native 创建的子 Workflow；接入时用原生类型/类型守卫确认。
execution.options.pruneSnapshot = ({ snapshot }) => snapshot;
```

实验入口为 `probe.ts crash-unpruned` 与 `probe.ts recover-unpruned`。无需修改官方 snapshot 数据，也无需修改已安装依赖。两个独立进程之间只通过公开导出的 `checkpoint-unpruned.bin` 传递状态。

这个 getter 对象目前可写是固定版本的真实行为；它不是 Agent 配置文档承诺的顶层配置项，必须保留兼容性回归。完全关闭裁剪保留多份历史，不能不计存储和 RPC 体积地直接放大到 80 步。

更保守的裁剪配置方向是保留原函数，对 running 快照另外保留 restart 实际读取的历史来源，其他状态仍交给原裁剪函数；**本次未把这个按路径选择的最小保留策略实跑到所有步骤边界，不能宣称它已通过**。尤其工具 foreach/collect-tool-results 会读取其他步骤结果，不能只凭本次模型边界实验保留单个前驱就推广到全部恢复点。

### 已验证的恢复语义

| 场景 | 实测 |
| --- | --- |
| `crash-budget-unpruned` → `recover-budget-unpruned` | maxSteps=3，先前已完成 1 步，模型持续请求工具，恢复正好再执行 2 步，原始上限累计生效 |
| `recover-cancel-unpruned` | recover 接收新的 AbortController.signal；恢复中的 fake model 接收到 abort，恢复段未执行工具 |
| 恢复流 UI chunks | 只有恢复后部分；没有重播工具 1，也没有新的 start chunk |
| 取消流 UI chunks | 仅 finish，finishReason 为 other；没有 abort chunk。平台应依据自身真实 cancelled 状态标记终态 |
| 正常完整运行 usage | 36 input + 12 output = 48 tokens，3 steps |
| 正常恢复段 usage | 24 input + 8 output = 32 tokens，2 steps，不包含先前 1 步 |
| 取消恢复段 usage | 本段 0 steps，却返回先前 1 步的 12 input + 4 output；不能把每段 aggregate usage 直接相加 |

因此完整 run 用量和步骤应以已持久化的实际模型请求记录去重汇总；阶段返回的 `output.usage` 是 fallback 和分段混合语义，不能独立承担全程计费或预算证据。

### 上游最小修复定位与实证边界

本次另外把 core 复制到 scratch 的 `patched-core/`，只修改副本。`patched-probe.ts` 使用该副本；已安装依赖、生产源码、依赖清单和 lockfile 均未由本实验修改。

1. source map 对应 **`src/workflows/handlers/entry.ts`** 的 `executeEntry`。单步路径调用 `getResumeStepPrevOutput` 时只识别 resume，应同样识别 restart 中已经 running 的 active step，使用其自身 payload，而非被裁剪的前驱 output。副本中把条件扩为：

   ```ts
   const isResumedStep =
     (resume?.steps?.includes(stepId) ?? false) ||
     (!!restart?.activeStepsPath?.[stepId] &&
       stepResults[stepId]?.status === 'running');
   ```

   `patched-probe.ts normal`、`crash`、`recover` 实跑成功，恢复官方默认裁剪快照，不做 snapshot repair、不关闭裁剪，工具 1 不重执行。**此修复仅验证了当前多步模型边界，尚须 pending/terminal/parallel/foreach 等上游回归。**

2. hooks 的一个初步假设是 DurableAgent wrapper 的私有 hook 配置未与 wrapped Agent 共享。副本尝试让 `Agent.resolveToolHooks` 调用已委托的 `getConfiguredToolHooks()`，但恢复 hooks 仍未触发。**这个假设尚不完整，该改动不能作为已经验证的 hooks 修复提交。** 已确认的事实是 normal before/after 各 2 次，恢复段工具执行 1 次而 before/after 均 0 次。

副本实验日志为 `patched-normal.jsonl`、`patched-crash.jsonl`、`patched-recover.jsonl`。默认路径、公开 options 路径及副本路径分开记录，避免把诊断成功混成默认配置成功。
