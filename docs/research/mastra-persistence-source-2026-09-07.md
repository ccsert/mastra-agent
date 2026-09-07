# Mastra 持久化恢复：固定发布源码核查

日期：2026-09-07。对应研究票 24。范围为 **core 1.64.0 + libsql 1.22.3 的 default workflow engine**；这是源码事实，不是生产恢复验收。

## 证据范围

- 发布提交固定为 `c19a93b0956f957581931786645d0597efec41eb`。`git ls-remote` 核实 `@mastra/libsql@1.22.3` 注释标签为 `19d3a045f720b7bf9494ef270c5d3b5dc9e7f94b`，解引用到该提交。[发布标签](https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Flibsql%401.22.3)
- 读取已安装 npm 包内 `sourcesContent`；与该提交 raw 文件逐字比较，以下七个文件全部一致：core 的 `mastra/index.ts`、`workflows/workflow.ts`、`workflows/utils.ts`、`workflows/entry-executors/run-tool-entry.ts`、`workflows/handlers/step.ts`，以及 libsql 的 `storage/domains/workflows/index.ts`、`storage/domains/workflow-definitions/index.ts`。
- 本子研究没有启动数据库、运行工具或工作流、调用模型；跨进程结果由主实验单独记录。下列链接均固定提交，不依赖主分支现状。

## 结论与平台含义

| 问题 | 发布源码事实 | 平台含义 |
| --- | --- | --- |
| 同 workflow ID 覆盖后恢复用哪个图？ | `createRun()` 从当前 Workflow 取得 executionGraph；`_resume()`、`_restart()` 传递 Run 的当前 graph，快照提供输入、状态、已执行结果与路径。[创建 Run](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L2596-L2622)、[恢复](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4667-L4685) | 跨进程重新装配同 ID 的新定义会使用新图/依赖；快照本身不冻结旧实现。发布版本应映射不可变执行 ID。 |
| 工具实现如何恢复？ | rehydrate 按 `toolId` 从当前 Mastra 注册表取工具；运行时优先已有 tool handle，否则查注册表。[rehydrate](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/rehydrate.ts#L299-L307)、[工具执行器](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/entry-executors/run-tool-entry.ts#L12-L19) | workflow ID 固定仍不够；工具、Agent、嵌套工作流及其构建产物必须按版本装配。 |
| 保存定义是否保留历史版本？ | `addDynamicWorkflows()` 替换同 ID 注册表，然后逐个 `store.upsert()`；libsql 更新同 ID 行，没有自动追加版本历史。[注册/保存](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L5120-L5162)、[定义存储](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/stores/libsql/src/storage/domains/workflow-definitions/index.ts#L100-L160) | 平台自己的版本库与发布事务不能直接等同于此 upsert；多成员写入中途失败也不保证存储整体回滚。 |

### serializedStepGraph 保存的是图描述

Agent 项包含 step ID、agentId、描述及可序列化选项；tool 项类似并含 toolId；嵌套 workflow 可带嵌套图；普通 step 保存 ID、描述、metadata、component、嵌套图以及 canSuspend，**不保存 execute 闭包、依赖包和完整运行环境**。[序列化入口](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L566-L610)

部分旧式 mapping/条件/sleep 会保存函数字符串，mapping 字符串还可能截断；因此也不能把整份 serializedStepGraph 解释成“所有内容都无代码”或可独立恢复的可执行归档。恢复路径没有从快照重建旧 JS 实现。[mapping 序列化](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L2157-L2193)

### 初始化顺序

这版公开入口是 `mastra.startWorkers()`，未发现 `Mastra.init()`。`startWorkers()` 先 `await storage.init()`，再读取 active 动态定义并按嵌套依赖顺序装配，随后启动目标 workers；`startEventEngine()` 是旧别名。仅 `storage.init()` 不会装配动态定义。[初始化存储](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L6261-L6274)、[加载点](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L6344-L6347)、[旧别名](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L6619-L6625)

工具/Agent 注册须在 rehydrate 前可用。代码预注册的同 ID workflow 优先于存储行；坏行或无法解析的依赖记录日志并跳过；启动加载对不支持的 schema 可警告降级，保存路径更严格。因此不能只以 `startWorkers()` 返回成功判定某发布版本可运行。[动态加载](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L5192-L5256)

```ts
// 示例顺序；工具实现和 ID 必须由平台按发布依赖装配。
const mastra = new Mastra({ storage, tools: versionedTools });
await mastra.startWorkers();
const workflow = mastra.getWorkflow(immutableWorkflowId);
const run = await workflow.createRun({ runId: persistedRunId });
const result = await run.resume({ resumeData: approvedInput });
```

### Tool 节点的挂起/恢复接口

`createStepFromTool()` 复制工具的 input/output/resume/suspend schema。执行签名为 `tool.execute(inputData, context)`；context 同时提供 `resumeData` 和 `workflow.{runId,workflowId,suspend,resumeData,state,setState}`。挂起使用 `context.workflow.suspend(payload)`，恢复输入从 `context.resumeData` 或 `context.workflow.resumeData` 读取。[工具步骤工厂](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/step-factories.ts#L84-L120)、[完整 context 映射](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/entry-executors/run-tool-entry.ts#L21-L53)

挂起后的恢复会重新进入步骤实现；不能把 `suspend()` 当成保存 JS 调用栈。业务写入应放在显式恢复/许可分支中，并由平台审批记录、输入绑定和业务幂等键约束，不能仅信任外部传入的 `approved: true`。[恢复执行入口](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4667-L4685)、[步骤调用](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/handlers/step.ts#L289-L308)

### resume / restart 状态边界

| 保存的 run 状态 | `resume()` | `restart()` |
| --- | --- | --- |
| suspended | 允许；需解析挂起步骤、校验恢复数据并尝试占用 | 拒绝为非 active；应走 resume |
| running / waiting | 不满足 suspended 校验 | 用保存的 active paths、step results、state 继续 |
| success / failed / tripwire | 拒绝 | 返回已保存的终态结果，不重做步骤 |
| pending | 不满足 suspended 校验 | 仅有保存 input 的 pending 分支支持；源码用于尚未开始的嵌套工作流 |
| canceled / bailed 等 | 不满足 suspended 校验 | 现有分支拒绝为非 active |

证据：[resume 状态校验](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4458-L4467)、[restart 终态分支](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4731-L4797)、[restart 参数构建](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/utils.ts#L577-L633)。这是默认引擎范围，不外推到全部引擎或所有嵌套/并行形态。

### 并发恢复已有保护，但不是完整租约

`_resume()` 在执行前调用 `#claimResume()`，通过 `updateWorkflowState({status:'running', expectedStatus:'suspended'})` 竞争占用；失败方抛出 `WORKFLOW_RESUME_ALREADY_CLAIMED`。若 `shouldPersistSnapshot` 排除 running，或存储报告不支持并发更新，则警告并跳过占用。[占用实现及降级](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4319-L4407)

libsql 1.22.3 报告支持并发更新，并在 write transaction 中读取、校验 expectedStatus、更新、提交。另有 WeakMap 实现的共享 client 写串行化；这个锁是进程内的，跨进程竞争由数据库写事务承担。[libsql 事务](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/stores/libsql/src/storage/domains/workflows/index.ts#L214-L277)、[进程内锁](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/stores/libsql/src/storage/db/write-lock.ts#L1-L44)

这个恢复占用路径没有 owner/过期时间/心跳/fencing token；比较条件是 status，不能从中推导带“挂起代次”的一次性业务审批协议。进程崩溃后也不能据此推导自动接管时限。`restart()` 路径未调用同一 resume 占用。平台仍须定义执行归属、失联处置与副作用准入；不能笼统说“Mastra 没有任何并发保护”。[恢复调用点与释放条件](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4614-L4665)、[restart 执行](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/workflow.ts#L4797-L4840)

### 检查点与外部业务副作用不是同一事务

步骤先持久化 running 信息，再调用用户实现，获得输出后才形成 success 等结果；libsql 的事务只包围自身快照读写，未包围工具对外部业务系统的写入。因此“外部写成功、完成检查点未保存”是恢复设计必须处理的窗口；仅靠框架检查点不能保证 exactly-once。[步骤开始落盘](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/handlers/step.ts#L165-L217)、[调用实现](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/handlers/step.ts#L289-L308)、[完成结果生成](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/handlers/step.ts#L504-L557)

平台建议：恢复绑定不可变 workflow ID 与依赖清单；对外写入使用业务幂等键和结果查询/对账；不支持幂等或结果查询的写入在结果不明时进入人工核对。最终是否重复、并发抢占表现与崩溃后状态，以本地跨进程实验和后续客户 Linux 验收分别记录，不能由源码分析替代。
