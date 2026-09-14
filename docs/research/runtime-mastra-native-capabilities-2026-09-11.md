# Runtime 自实现 vs Mastra 原生能力（2026-09-11）

## 背景

审一遍 `apps/runtime`，找出「自己实现了一遍、而 Mastra 原生已经提供」的能力。
结论先行：**整体相当克制**。agent 执行、流式转换、工作流编排、Skill 装载、RAG 切分
都走的是原生 API。只有一处是真正意义的重复造轮子，另有几处是「可以更原生但换了别的
理由」，需要单独判断而不是直接改。

依赖版本：`@mastra/core@1.64.0`、`@mastra/ai-sdk@1.10.1`、`@mastra/rag@2.6.1`、`ai@7.0.93`。

---

## 一、明确重复造轮子

### 1.1 `observeTools` 手工改写 `tool.execute`

**位置**：`apps/runtime/src/agents/execute.ts:77-139`（迁移后为 `toolExecutionHooks`；
迁移前是 `observeTools`，`:82-134`）

迁移前的做法是自己遍历 `ToolsInput`，把每个工具的 `execute` 替换成一个计时包装：

```ts
const target = tool as { execute?: unknown }, run = target.execute;
target.execute = async (input, context) => { /* 计时 + 上报 + 原调用 */ };
```

**Mastra 原生等价物**（已验证）：

| 证据 | 内容 |
| --- | --- |
| `@mastra/core/dist/tools/types.d.ts:88-91` | `interface ToolHooks { beforeToolCall?, afterToolCall? }` |
| `@mastra/core/dist/tools/types.d.ts:82-87` | `ToolAfterHookContext` 含 `toolName` / `input` / `context` / `metadata` / `output?` / `error?` |
| `@mastra/core/dist/agent/agent.types.d.ts:546` | `AgentExecutionOptionsBase.hooks?: ToolHooks` —— **`agent.stream(messages, { hooks })` 就能传** |
| `@mastra/core/dist/agent/agent.d.ts:1082` | Agent 构造级 `hooks?: ToolHooks` |
| `@mastra/core/dist/agent-DsRUDsS_.js:36118-36156` | Mastra 内部 `wrapToolWithHooks`：把 `execute` 包一层，依次调 `beforeToolCall` → 原 `execute` → `afterToolCall`（失败路径也调，带上 `error`） |

**关键确认**：`wrapToolWithHooks` 传给 hook 的 `context` 就是工具 `execute` 收到的同一个
`context` 对象（`hookContext = { toolName, input, context, metadata }`）。因此
`context.agent.toolCallId` 在 hook 里同样可读 —— 现有的 `toolCallIdOf()`
（`execute.ts:68-75`）可以原样复用，不需要换取证方式。

**为什么算是重复**：runtime 自己实现了一遍 Mastra 内部本来就会做的包装。等价性很高，
但代价是：

- 依赖一个未文档化的内部形状 —— 「`ToolsInput` 的每个值都有可写的 `.execute`」。
  Mastra 自己是用 `{...tool, execute}` 生成新对象，而不是改写原对象；一旦工具不是
  普通对象（或 `execute` 不在自有属性上），runtime 的改写会静默失效。
- 拿不到 hook 里现成的 `metadata`（`agentId` / `agentName`）。
- 包装发生在 `new Agent()` 之前、`Object.assign(tools, prepared.tools)` 之后，
  位置对 `skill` / `knowledge_search` 也生效——这点碰巧和 agent 级 hook 的行为一致。

**收益与代价**：改动很小（删掉 `observeTools`，给 `stream()` 的 options 加 `hooks`），
风险低。**但要说清楚：这不是在修一个现存的 bug**，现有实现能跑通且有测试覆盖；
收益是「站到公开 API 上」，不是「修好一个坏掉的东西」。

**必须保留的部分**：`ToolObserve`（`tools/types.d.ts:131-134`，工具上下文里的
`observe.span` / `observe.log`）**不能**替代现在的做法。它是把 span 导给
observability 采集器的通道，没有采集器时是 `noopObserve`（同文件 `:141`），
`span()` 直接执行函数、`log()` 空转，**不产出任何可读的耗时数据**。而 runtime 需要的是
把耗时写进自己的 `run_events` 契约。所以：**拦截点应该换成原生 hook，输出通道
（自定义事件）仍然是 runtime 自己的事**。

#### 补充查证（实施前）：hook 的三个新约束

补查 `agent-DsRUDsS_.js:36118-36185` 后，有三条**原方案里没写到、但改写时必须处理**的事实：

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| hook 包的是 **`formatTools` 之后**的工具表 | `:36099-36100`（`formatTools(allTools)` → `wrapToolsWithHooks(...)`） | hook 收到的 `toolName` 是**模型实际看到的**名字。若某工具名被改名，按名字查 `sources` 会落空。当前工具名受契约约束 `^[a-z][a-z0-9_]{1,49}$`（`packages/contracts/src/tools.ts:11`），完全落在 `formatTools` 的合法集内，**改名不会发生**；但白名单查表必须保留，它是这条依赖的兜底 |
| **Mastra 不保护 hook 抛错** | `:36136`、`:36142`、`:36149` 三处都是裸 `await hooks.xxx?.()` | 成功路径：hook 抛错会让**工具调用本身失败**；失败路径：`afterToolCall` 抛错会**顶掉工具的真实错误**（`:36147` 的 `throw error` 执行不到）。即：迁移后「观测不改结果」这条原则**从「自然成立」变成「必须自己守」** |
| `formatTools` 是**原地改名** | `:36182-36183`（`tools[newKey] = tools[key]; delete tools[key]`） | 它改的是 `allTools`（一个 `{...requestResolvedTools, ...inputProcessorLoadedTools}` 的新对象，`:36095-36098`）。这正好解释了为什么旧的 `target.execute = ...` 改写能生效：工具对象是**共享引用**，键被搬走但对象还在 |

另外 `afterToolCall` 只在「按 id 配得上一次 `beforeToolCall`」时才有起止时刻可用
（hook 本身不给时长），所以配对状态必须自己存。

#### 实施结果（2026-09-11）

已实施。`execute.ts` 的 `observeTools` 换成了 `toolExecutionHooks(sources, onChunk): ToolHooks`，
经 `stream(messages, { hooks })` 传入（run 级，不落到 Agent 构造级）。

保留不动的东西：

- `sources` 白名单 —— hook 覆盖**全部**工具（含 `skill`/`skill_read`/`skill_search` 与
  `mastra_workspace_*`），仍只对 runtime 自己建的工具计时与归类。
- `toolCallIdOf()` 与「无 id 就不记」的规则。
- 事件契约与字段完全不变（`ToolExecution.parse` 仍是唯一出口）。
- 「观测失败不改运行结果」—— 但因为上面第 2 条，这条现在是**显式**守住的：
  两个 hook 的函数体各自整体包在 `try/catch` 里，任何异常都只表现为「这条没记上」。

新增的两个能力：

- `toolName` 改为取 Mastra 给的 `toolName`，不再由 runtime 闭包绑定 —— 记录的名字
  与模型看到的一致。
- 失败判定改用 `"error" in hook`：Mastra 只在调用抛错时挂 `error` 键，而工具**合法地
  返回 `undefined`** 是允许的，所以不能用 `output === undefined` 反推失败。

验证：

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | 通过 |
| Lint | `pnpm lint` | 通过（295 files） |
| 架构 | `pnpm architecture:check` | 通过（232 modules / 876 deps） |
| 构建 | `pnpm build` | 通过 |
| 契约/SDK | `pnpm sdk:check` | `OpenAPI and SDK match the route contracts.` |
| 端到端 | `tests/integration/integration.test.ts` | 通过。该用例（`:235-245`）断言**恰有 1 条** `data-tool-execution`、`toolName=sum_values`、`source=sum`、`outcome=succeeded`，且 `toolCallId` 等于模型流里 `tool-input-available` 的 id —— 迁移后仍然成立 |
| 单元 | `tests/runtime/tool-observation.test.ts` | 新增 10 条，全通过 |
| 全量 | `pnpm test` | 78 tests / 76 pass / **0 fail** / 2 skipped。跳过的 2 条是 Docker 沙箱用例（`ok 65`/`ok 66 ... # SKIP`，需要专用镜像），与基线一致，不计为通过 |
| 控制台 | `pnpm test:console` | 72 pass / 0 fail。首次运行有 1 条失败（`logout unmounts project requests…`），单独重跑该文件 10/10 通过、全量重跑 72/72 通过 —— 属跨文件状态的偶发，且该文件不引用 runtime，与本轮改动无关 |

新增单测覆盖的是**迁移带来的新风险面**（集成测试只覆盖「成功 + 已归类」这一条路径）：
返回 `undefined` 仍算成功、失败保留已知错误码、未知错误码不被编造、非 `Error` 抛出、
未归类工具不记、无 `toolCallId` 不记、只有 finish 没有 start 不记、`onChunk` 拒绝时
hook 不 reject、同名工具多次调用各自计时。

**边界**：迁移**没有**动采集的内容与语义，也没有动控制台/控制面（`data-tool-execution`
目前仍无下游消费者，见 `docs/research/trajectory-collection-p0-2026-09-11.md:32`）。
「hook 覆盖全部工具但只记白名单」这一点由单测断言，未在真实 skill 运行中验证。

---

## 二、可以更原生，但有理由（需判断，不建议直接改）

### 2.1 工作流生成的 `submit_workflow` 工具 + 3 次重试循环

**位置**：`apps/runtime/src/workflows/generate.ts:36-47`（工具）、`:53-76`（循环）

现状：用 `createTool` 造一个 `submit_workflow`，在 `execute` 里把候选存进闭包变量
`candidate`，并用 `toolChoice: { type: "tool", toolName: "submit_workflow" }` 强制模型调用它；
外面再套 `for (attempts 1..3)`，把平台校验得到的 `issues` 塞回 prompt 重试。

Mastra 原生有两个看似对应的能力：

| 证据 | 内容 |
| --- | --- |
| `dist/agent/agent.types.d.ts:450`、`:730` | `structuredOutput: StructuredOutputOptions<OUTPUT>` —— 原生结构化输出 |
| `dist/agent/agent.types.d.ts:534` | `errorProcessors?: ErrorProcessorOrWorkflow[]` |
| `dist/agent/agent.types.d.ts:540` | `maxProcessorRetries?: number` —— 「处理器可触发的重试次数」 |

**为什么不能直接替换**：

- 「用工具承接结构化输出」在这里是**故意**的：`submit_workflow` 的 `execute` 会把
  `validateWorkflowProposal()` 的结果**作为工具返回值回给模型**，形成
  「提交 → 拿到校验错误 → 修正」的回路。纯 `structuredOutput` 只负责把结果解析成对象，
  拿不到这条中间反馈。
- 那 3 次循环不是 transport 重试，是**应用层业务重试**（「校验没过就再生成一次」）。
  `errorProcessors` / `maxProcessorRetries` 面向的是 processor 触发的重试，语义是否
  能承载「注入校验反馈后重来」**未验证**。

**结论**：这是「借工具实现带反馈的结构化输出」，不是纯粹的重复。要动的话，
`structuredOutput` + `errorProcessors` 是否等价需要先做一个探针验证，收益是去掉一个
只为承接输出而存在的工具定义。

### 2.2 embed / rerank 手写 fetch

**位置**：`apps/runtime/src/knowledge/knowledge.ts:12-52`（`modelJson`）、`:53-85`（`embed`）、
`:98-128`（rerank）

现状：embedding 与 rerank 都是手写 `fetch` + 手写响应解析。切分用了原生的
`@mastra/rag` 的 `MDocument.fromText(...).chunk(...)`（`:153-159`），这一步是原生的。

**可用原生物**：`@mastra/rag` 与 AI SDK 的 embedding 接口（runtime 已依赖
`@ai-sdk/openai-compatible`，`:217`）。

**为什么暂不动**：手写部分夹带了明确的契约校验，换原生要逐个确认仍成立：
`index` 必须与输入顺序一一对应（`:80`）、维度一致（`:83`）、
响应体 8MB 上限（`:41`）、只取每租户 key（`keys[model.id]`）。

**结论**：优先级最低。真要收敛，也应先确认这些校验能不能在原生路径上保留。

### 2.3 MCP 用官方 SDK 而非 `@mastra/mcp`

**位置**：`apps/runtime/src/mcp/mcp.ts:1-3`（用 `@modelcontextprotocol/sdk`）

**各模块现状对照**（已验证）：

| 模块 | 用了什么 |
| --- | --- |
| `@mastra/core/mcp` | 主要导出 `MCPServerBase`（**服务端**）；客户端在**未安装**的 `@mastra/mcp` |
| `apps/runtime/src/mcp/mcp.ts` | 官方 `@modelcontextprotocol/sdk` + `StreamableHTTPClientTransport`（`:33`） |

**为什么不动**：这里夹带了平台治理语义，不是通用客户端：
端点白名单校验（`:21-29`）、请求/响应体上限（`:45`、`:58`）、
发现结果 `canonicalJson` 比对以检测契约漂移（`:144`）、每次调用前后各授权一次（`:146`、`:175`）、
schema 编译（`compileMcpSchema`）。且 `reconnectionOptions.maxRetries` 被显式设为 `0`（`:38`）——
**这是「主动关掉原生重试」，不是重复实现原生重试**。

### 2.4 Docker 沙箱

**位置**：`apps/runtime/src/skills/sandbox.ts:55-124`

现状是有意加固的一组参数：`--cap-drop ALL`、`no-new-privileges`、只读 rootfs、
`--pids-limit`、无网络、脚本不接触宿主 socket，并先用一个停止状态的 helper 容器
把文件中转进私有 volume（`:62-77`）。Mastra 的 Workspace sandbox 是另一条产品线，
**结论：不动**。

---

## 三、已正确使用原生能力（无需改动）

| 位置 | 原生用法 |
| --- | --- |
| `execute.ts:239-245` | `mastra.getAgent("runner").stream(messages, { maxSteps, abortSignal, modelSettings, hooks })` |
| `execute.ts:246-251` | `toAISdkStream(result, { from: "agent", version: "v7" })`（`@mastra/ai-sdk`） |
| `execute.ts:277-281` | 直接读 `MastraModelOutput` 的 `totalUsage` / `steps` / `finishReason` Promise |
| `execute.ts:151-180`、`:187-213` | `createTool({ inputSchema, outputSchema, execute })` |
| `workflows/execute.ts:37-43`、`:51-56`、`:107-117` | `createWorkflow` / `createStep` / `branch().map().commit()` —— 平台受限画布到 Mastra 工作流的编译，不是重复实现编排 |
| `skills/skills.ts:120-124`、`:19-50`、`:108-119` | `Workspace` / `BlobStore` 子类 / `CompositeVersionedSkillSource`（详见第三节补充） |
| `mcp/mcp.ts:74-88` | 官方 SDK 的 `jsonSchemaValidator` 扩展点 |

### 三补：Skill 装载确实是「工具调用」，而且我们用的就是原生那套

**先纠正本文早先的含糊表述。** 首次成文时只写了「skills 用原生」，没有写清机制。
补查后确认：官方 Skill 装载**本身就是工具调用**，并且 runtime 走的就是原生实现。

官方文档明确写着（<https://mastra.ai/docs/skills>）：

> The agent automatically gets `skill`, `skill_read`, and `skill_search` tools so it can
> discover and load skills during conversations.

源码层面，配好 `Workspace.skills` 后，Mastra 自动做两件事（都不需要我们声明）：

| 自动行为 | 证据 |
| --- | --- |
| 注入可用 Skill 目录到 system message | `SkillsProcessor.processInputStep` → `messageList.addSystem(<available_skills>…)`，`dist/agent-DsRUDsS_.js:15691-15708`；目录渲染 `formatSkillsCatalog`，同文件 `:15590-15609`（含 `name`/`description`/`location`/`source`，XML 格式） |
| 挂上 `skill` / `skill_read` / `skill_search` | `createSkillTools`（`dist/workspace/skills/tools.d.ts:19-40`）由 `Agent.listSkillTools` 调用，`dist/agent-DsRUDsS_.js:34606-34644` |
| 没有自配 processor 时自动创建 | `getSkillsProcessors`：`if (hasSkillsProcessor \|\| hasOnDemandProcessor) return []`，否则 `return [new SkillsProcessor({ skills, format })]`，`dist/agent-DsRUDsS_.js:32968-32980`；经 `resolveInputProcessors` 无条件并入，同文件 `:33222-33237` |

**`tools: { enabled: false }` 不会关掉 skill 三件套。** 这条容易误判，两个独立证据：

1. `tools.enabled` 管的是 `mastra_workspace_*`。`WORKSPACE_TOOLS` 常量里只有
   FILESYSTEM / SANDBOX / COMPUTER / SEARCH / LSP（`dist/workspace/constants/index.d.ts`），
   **没有** `skill` / `skill_read` / `skill_search`。而 Agent 侧是两条独立路径：
   `listWorkspaceTools`（`:34553`，读 `tools.enabled`）与 `listSkillTools`（`:34606`，完全不读）。
2. 本仓库测试直接断言了这一点（`tests/integration/skills.test.ts:311-313`）：

   ```ts
   assert.ok(model.advertisedTools.has("skill"));
   assert.ok(model.advertisedTools.has("skill_read"));
   assert.equal(model.advertisedTools.has("mastra_workspace_execute_command"), false);
   ```

   即：skill 工具在，通用命令工具不在——正是本来的设计意图（见
   `docs/research/mastra-skill-runtime-boundary-2026-09-07.md:41`：skill 三件套由独立
   `createSkillTools()` 路径创建，不能凭 Workspace 通用开关推断）。真实运行也留了记录：
   `docs/research/conversation-trajectory-2026-09-09.md:34` 记下首次模型请求带着
   `run_skill_script` / `skill` / `skill_search` / `skill_read` 四个工具定义。

所以「skill 装载是工具调用的实现」这个观察是**对的**，而且**不是我们自造的**：
runtime 只传了 `workspace`，目录注入与三个工具都由 Mastra 自动挂载。

#### 我们额外加的那层：把用户选中的 Skill 预载进 instructions

**位置**：`apps/runtime/src/skills/skills.ts:125-136`

```ts
const selected = snapshots.filter((s) => selectedIds.includes(s.id));
const instructions = selected.length
  ? "\n\n用户为本次任务明确指定以下 Skill。……\n" +
    (await Promise.all(selected.map(async (s) =>
      `\n--- Skill ${s.name} v${s.version} ---\n${(await read(s, "SKILL.md")).toString("utf8")}\n--- End Skill ---`
    ))).join("\n")
  : "";
```

这是**「用户显式固定」语义**，与原生「模型按需发现」互补，不是把工具机制重做一遍：

- 原生目录只给 `name` / `description` / `location` / `source`，正文要模型自己调 `skill` 去取。
- 我们这层对 `skillVersionIds` 指定的 Skill 直接内联 `SKILL.md` 正文，保证一定会进上下文。

**没有找到原生的等价 API。** 1.64.0 里 `formatSkillActivation`
（`dist/workspace-smVhYwIC.js:5902-5908`）虽然注释说是「`skill` 工具与 explicit user
activations 两条路径共享」，但实际只有 `skill` 工具在调用它（同文件 `:5947`），
Agent 侧没有暴露「预载/激活指定 Skill」的公开入口；`SKILL.md` 的 `user-invocable`
字段也只做解析与回写（`dist/workspace-skills-quChTuB_.js:1435-1437`、`:1493`），
core 里没有消费它的行为。**所以这层是补了一个真空白。**

两处值得注意的偏差（不是 bug，是可选的收敛点）：

| 项 | 原生 `formatSkillActivation` | runtime 预载 |
| --- | --- | --- |
| 内容 | 指令 + `## References` / `## Scripts` / `## Assets` 清单 | 只有 `SKILL.md` 正文 |
| 校验 | 经 `skillSource` 读取 | 经控制面读取并核对 size + sha256（`skills.ts:79-92`） |

即：我们的预载**少了**文件清单（脚本入口改由 `run_skill_script` 的工具描述枚举，
`skills.ts:151-152`），但**多了**摘要校验。若要对齐，`formatSkillActivation` 是从
`@mastra/core/workspace` 公开导出的，可以直接复用；但它是按 `Skill` 对象成形，
而平台侧持有的是带 `files` 的 `SkillSnapshot`，需要一层转换。**未实施。**

另一处成本：被固定的 Skill 会同时出现在原生目录里（name/description）和预载正文里；
如果模型再去调一次 `skill`，正文会在上下文里出现第二次。属于小的重复开销，未处理。

### 关于「不用 Memory」

`apps/runtime` 没有 `new Memory()`，对话历史由控制面经 `ExecutionJob.messages` 下发，
runtime 用 `validateUIMessages` + `convertToModelMessages`（`execute.ts:231-232`）转换。
这是**有意不用**，不是重复造轮子：Memory 会引入它自己的线程/持久化语义，
与平台自己的 sessions / runs 落库模型重叠。若要改，是架构决策而非去重。

### 关于 `retryConfig: { attempts: 0 }`

`workflows/execute.ts:42` 与 `mcp.ts:38` 都是**主动关闭**原生重试。
同样是「不用」而不是「重造」。

---

## 四、待确认项

### 4.1 `readUIMessageStream` 手工装配最终消息

**位置**：`execute.ts:246-263`

现状把 `toAISdkStream` 的结果 `tee()` 成两支：一支逐 chunk 交给 `onChunk`，
另一支喂给 AI SDK 的 `readUIMessageStream` 来拼出 `finalMessage`。

**候选原生物**：`MastraModelOutput.get response()` 的返回类型里带
`uiMessages?: UIMessage[]`（`@mastra/core/dist/stream/base/output.d.ts:168-179`）。

**为什么是「待确认」而不是「重复」**：平台持久化的明确是 `toAISdkStream` 的 **v7**
UI 消息（见项目记忆），而 `response.uiMessages` 的内部版本是否与之完全同形、
能否稳定拿到最后一条 assistant 消息，**未验证**。在验证之前不应替换 ——
换错会让持久化格式漂移，属于静默性质的问题。

**另一个同源候选**：`MastraModelOutput.getFullOutput()`
（`output.d.ts:200`，返回类型 `FullOutput` 见同文件 `:30-60`）一次性给出
`text` / `usage` / `steps` / `finishReason` / `toolCalls` / `toolResults` / `totalUsage` / `object` / `error`。
现在 `execute.ts:271-275` 是分三个 `settled()` 分别读。**倾向于不改**：`settled()`
（`:40-52`）给每个等待加了 2s 上限，而 `getFullOutput()` 没有超时语义 ——
现在这个写法对「流挂了但 Promise 不 settle」的防护更明确。

### 4.2 工具耗时是否真无原生来源

已核实**没有**：`LLMStepResult`（`dist/stream/types.d.ts:1209-1247`）字段里没有
`performance`；`ToolCallChunk.payload.observability`
（`dist/stream/types.d.ts:146-166`）是**客户端执行**工具的 W3C trace 载体，
不是服务端工具耗时。

**结论**：单个工具的服务端执行耗时，Mastra 只通过
① `hooks.afterToolCall`（拿到起止时刻要自己记，因为它只给 `output`/`error` 不给时长）
② `observe.span()`（需要 `@mastra/observability`，**当前未安装**，`pnpm-lock.yaml` 里没有）
两条路给。所以**耗时的采集本身必须由 runtime 做**，Mastra 只提供拦截点。
这进一步说明 1.1 的正确改法是「换拦截点」，而不是「删掉采集」。

---

## 汇总

| # | 项 | 判定 | 结论 |
| --- | --- | --- | --- |
| 1.1 | `observeTools` 改写 `tool.execute` | 明确重复 | **已实施**：换成 `agent.stream({ hooks: { beforeToolCall, afterToolCall } })`，自建事件通道与白名单保留 |
| 三补 | Skill 装载（目录注入 + `skill`/`skill_read`/`skill_search`） | **已在用原生** | 无需改动。`tools.enabled: false` 只关 `mastra_workspace_*`，不影响 skill 工具 |
| 三补 | 用户选中 Skill 预载进 instructions | 补原生空白 | 可选：复用公开导出的 `formatSkillActivation` 对齐文件清单。**未实施** |
| 2.1 | `submit_workflow` + 3 次循环 | 有理由 | 先探针验证 `structuredOutput` + `errorProcessors` 是否等价。**未实施** |
| 2.2 | embed / rerank 手写 fetch | 有理由 | 低优先，换前先保住现有校验。**未实施** |
| 2.3 | MCP 用官方 SDK | 有理由 | 不动（治理语义 + 主动关重试） |
| 2.4 | Docker 沙箱 | 有理由 | 不动（有意加固） |
| 4.1 | `readUIMessageStream` 手工装配 | 待确认 | 先验证 v7 消息同形再谈替换。**未实施** |
| — | Memory / `retryConfig` | 不是重复 | 属于「有意不用」 |

**边界说明**：本轮只实施了 1.1。2.1 / 2.2 / 4.1 均**未验证也未改动**。
1.1 的实施范围严格限于「换拦截点」：事件契约、字段、`sources` 归类规则、
「观测失败不改运行结果」的行为都未变，控制面与控制台未动。
验证记录见 1.1 的「实施结果」小节（`pnpm typecheck` / `pnpm lint` /
`pnpm architecture:check` 通过，新增 10 条单测通过，端到端集成测试通过）。
第三节补充中关于 skill 的「已在用原生」有本仓库测试与真实运行记录双重佐证，
是本文证据最强的一条。
