# 长时网页构建 Agent：一手资料核对

核对日期：2026-09-13。范围：评估下一步能力建设，以及 70–80 步复杂网页任务的验证方法。本次只完成公开资料研究，没有启动付费模型长跑、提交奖项或发布网站。

**建议先验证 Mastra 原生能力在固定版本上的组合，再建设网页执行环境与质量验收。** 80 步可以作为耐久性压力场景，不能直接成为网页完成或视觉质量的指标。以下“官方事实”来自本次访问的一手页面；“本项目判断”是结合主任务代码审查输入的工程建议，不代表官方保证。

## 八个可复用判断

### 1. 把可续作的项目状态作为交付物

**官方事实：** Anthropic 的长任务实验采用首次初始化与后续增量开发两种会话职责；保存功能清单、进度记录、启动脚本和 Git 历史，并要求浏览器验收后才将功能标记为通过。文章同时指出，仅有上下文压缩仍会出现半成品和过早宣布完成。[Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**本项目判断：** 网页任务至少应持久化需求与验收项、当前代码版本、可重建环境信息、已完成项、未解决问题和下一步。每个里程碑携带浏览器证据；不能只持久化一句对话摘要。初始化与后续开发可以是同一 Agent 的不同阶段，不必因此引入两个完整执行系统。

### 2. 优先复用原生 Harness 能力，保持组合边界

**官方事实：** Mastra 将 Harness 描述为可独立采用的能力集合：Durable Agents 管执行与重连，Goals 管目标持续推进，AgentController 管交互会话与运行控制，`createCodingAgent()` 提供工作区、任务跟踪和重试等默认配置。[Mastra：Harness](https://mastra.ai/docs/harness/overview)

**本项目判断：** 先做固定 `@mastra/core@1.64.0` 的兼容性小实验，验证原生 Agent、控制器、持久化和平台现有租约如何配合。无需为了达到 80 步先自研完整模型循环，也无需先引入 Temporal 或第二套任务调度系统。控制面继续负责发布、凭证授权、预算和执行权；SDK 负责其已覆盖的运行机制。

### 3. 流重连、执行恢复、外部副作用是三个验收对象

**官方事实：** Durable Agents 使用事件缓存支持 `observe()` 重连，默认内存缓存只能覆盖单进程；崩溃恢复从持久化状态重新驱动，可能重新调用模型和工具。文档仍提示多实例恢复需要自行控制唯一恢复者。[Mastra：Durable agents](https://mastra.ai/docs/harness/durable-agents)

**本项目判断：** SSE 断线重连成功只能证明用户重新收到事件。进程被杀后继续推进需要存储与运行重建；工具调用跨崩溃不能默认仅执行一次。以现有平台租约作为唯一执行权来源，验证恢复期间的 fencing、取消与重复提交。涉及外部写入的工具按业务副作用定义幂等键；不能只去重前端事件。

### 4. Workflow suspend/resume 用于明确等待点

**官方事实：** Workflow 的 `suspend()` 保存快照，`resume()` 以 `resumeData` 恢复暂停步骤；快照依赖配置的存储，可跨应用重启。官方用途包括等待补充数据、API 回调或人工输入。[Mastra：Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)

**本项目判断：** 在资料补充、设计方向确认、外部回调等有明确状态的节点采用 Workflow 很自然。网页开发内部的连续工具选择应先交给原生 Agent；不要先把“第 1–80 次模型调用”建成业务工作流节点。步骤恢复会重新进入相关执行逻辑，暂停前的副作用仍需单独处理。

### 5. 上下文管理要保留证据索引，并按需取回

**官方事实：** Anthropic 建议以文件路径、链接等轻量标识按需取回上下文，并结合压缩和外部结构化笔记；过度压缩可能丢失后来才显得关键的信息。[Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**本项目判断：** 将网页截图、DOM、控制台日志、测试输出保存为可追踪产物，在上下文里保留结论和引用。任务摘要需要保留用户约束、设计决策、尚未修复的问题、验收失败和下一步。压缩是继续推理所需的视图，原始轨迹与产物仍由审计存储保留。

### 6. 优先评估 Memory/OM，不把它等同于运行恢复

**官方事实：** Mastra Memory 区分消息历史、结构化 Working Memory、Semantic Recall。Observational Memory 使用 Observer/Reflector 将旧历史转为观察记录，要求存储，并会产生额外模型调用；当前文档列出有限的受支持存储适配器，且要求客户端只提交新消息。[Mastra：Memory](https://mastra.ai/docs/memory/overview)、[Mastra：Observational Memory](https://mastra.ai/docs/memory/observational-memory)

**本项目判断：** 先确定租户、资源、会话与任务的映射，再验证 OM 在项目固定依赖下的存储接口和成本。不要用用户可控的裸 ID 作为跨租户隔离策略。OM 能减轻上下文负担，但不能恢复运行中的浏览器、shell 进程或外部工具副作用；它也不能替代平台租约和任务状态机。

### 7. 网页构建需要真实、隔离且可恢复的执行环境

**官方事实：** Mastra Workspace/Sandbox 提供文件、命令和进程能力；`LocalSandbox` 默认在宿主机执行，静态实例可能被多个请求共享。Browser 由具体 provider 提供页面交互工具，可连接 CDP 服务；仅声明模型能力不会产生浏览器实例。[Mastra：Sandboxes](https://mastra.ai/docs/sandbox/overview)、[Mastra：Browser](https://mastra.ai/docs/browser)

**本项目判断：** 企业网页任务应绑定任务专属工作区、沙箱及浏览器会话，并提供受控预览地址。先打通“改文件 → 安装/构建 → 启动 → 浏览器访问 → 截图与交互验证 → 修复”。按主任务本地审查，`createCodingAgent()` 的本地默认 cwd 不能直接成为多租户执行环境；Browser 基类和 `vision` 声明也不能算接入完成。

### 8. 将设计质量单独评分，70–80 步作为压力测试

**官方事实：** Awwwards 官方四维权重为 Design 40%、Usability 30%、Creativity 20%、Content 10%，由评委评估作品。该标准没有模型步骤数或工具次数指标。[Awwwards：Evaluation System](https://www.awwwards.com/about-evaluation/)

**本项目判断：** 可借用这四维建立内部质量表，但不能将内部模型评分称为 Awwwards 获奖证明。功能、响应式与真实浏览器验收作为通过门槛；设计、交互独创性和内容完成度另行评审。80 步应观察预算、持续推进、恢复和产物一致性，不能要求 Agent 为凑次数继续无效改动。

## 固定 SDK 版本的适配注意事项

主任务已核实本项目固定 `@mastra/core@1.64.0`；以下本地信息来自主任务审查输入，详细代码证据由[主方案](../planning/long-running-web-agent-2026-09-13.md)维护，本子任务没有重复深挖代码。

| 项目固定版本/现有边界 | 本次官方页面观察 | 实施要求 |
| --- | --- | --- |
| 已有 `Agent({ durable: true })`、`recover(runId)`、`recoverActiveRuns` | 最新 Durable 文档主要展示 `createDurableAgent()`，并标记 beta，允许无 major bump 的破坏变更 | 不直接复制 latest 示例；先以 lockfile、安装包声明和 mock crash case 为准。[版本漂移来源](https://mastra.ai/docs/harness/durable-agents) |
| 已有 `AgentController`，`Harness` 是 deprecated 别名 | 官方 Harness 已是能力集合；交互 API 名称为 AgentController | 区分架构概念与具体类名，避免新增对 deprecated 别名的依赖。[官方概念](https://mastra.ai/docs/harness/overview) |
| 原生 goal 机制标 experimental；无 judge 工具时只进行文本评判 | Harness 把 Goals 作为目标推进能力入口 | 本次未继续核实 Goals 具体配置；兼容性实验中验证实验性 API，不把文本自评作为截图/运行时验收。 |
| Runtime 不能直接访问平台数据库；当前每 job 新建 Mastra、未接 storage | Memory、OM 与恢复均需要可用存储；latest 的 Postgres 示例只是接入示例 | 先决定控制面适配存储或客户私有独立存储；不能为套用示例直接向 Runtime 引入共享平台数据库。[Memory 存储要求](https://mastra.ai/docs/memory/overview) |
| 平台已有执行租约；安装包提示自动恢复不提供跨实例锁 | latest 同一页既写 recovery lease，又在 Multi-instance 段落写无分布式 lease/lock | 官方措辞存在歧义，不能据此假设集群排他性；保持平台唯一执行权，并在两个 worker 下故障注入验证。[恢复边界](https://mastra.ai/docs/harness/durable-agents) |
| Workspace、Browser 基类已存在，尚无网页工具完整链路 | Workspace URL 重定向 Sandbox；Browser provider 在独立包 | 单独固定 provider、memory、storage 版本并检查 peer dependency；本次未安装或验证这些包与 1.64.0 的兼容性。[Browser provider](https://mastra.ai/docs/browser) |

## 建议的验证顺序

以下是工程验收建议，不是供应商给出的性能承诺。沿用主方案的 10 → 30 → 80 阶段，先验证机制，再增加真实任务复杂度。

| 阶段 | 主要问题 | 必须保留的证据 |
| --- | --- | --- |
| 固定版本 mock/小实验 | 原生 durable、Memory 与平台 lease 能否组合；暂停、取消、进程崩溃后是否符合状态语义 | 固定依赖和发布版本、runId、checkpoint、恢复前后调用记录、幂等副作用计数；不产生付费模型负担 |
| 约 10 步真实闭环 | Agent 能否实际修改并访问网页 | 构建输出、预览地址、浏览器截图、至少一个完成的交互验收项 |
| 约 30 步集成任务 | 修复和上下文压缩后还能否遵守原始约束 | 压缩前后约束核对、失败与修复轨迹、不同视口证据、模型与工具成本 |
| 70–80 步压力场景 | 长时间推进、断流、worker 重启及恢复能否保持任务与产物一致 | 恢复点、代码/产物版本、重复执行与取消结果、预算截止原因、最终功能与设计评分 |

每次记录三个独立计数：模型请求数、SDK step 数、工具调用数。工具可能并行，压缩/Observer/Judge 也可能增加模型请求，因此“80 步”必须明确口径。停止条件应为验收完成、明确阻断或预算耗尽；预算耗尽时保留可续作状态并报告未完成项。

内部质量表可使用 `0.4 × Design + 0.3 × Usability + 0.2 × Creativity + 0.1 × Content`，但应并列展示功能门槛和具体扣分证据。建议至少由独立视觉评审或人工复核检查关键截图与实际交互；不能让生成 Agent 自己一句“完成”覆盖失败测试。

## 获取方式与未验证边界

- Anthropic、Mastra Harness、Durable、Workflow、Memory、OM、Sandbox、Browser：本次通过 web 工具成功读取官方页面。网页内容为访问时 latest，没有固定到 `@mastra/core@1.64.0` 的文档快照。
- Awwwards `jury/` 与 `about-evaluation/` 的 web 打开失败；随后通过 `curl -L --fail --max-time 30` 成功获取 `about-evaluation/` 官方 HTML，去除标签后核实四项权重。没有使用第三方文章支持权重结论。
- 已发现 latest 文档的路由/API 漂移及 recovery lease 表述歧义。两者均需要固定版本实验解决，本次没有把网页说明当成本项目运行时验收。
- 尚未验证 provider 安装兼容性、真实视觉模型图像输入、客户私有环境隔离、持久化驱动的跨进程恢复、80 步成本或质量；也未执行实际模型长跑。
