# Mastra 官方 AI 工作流构建器与 FlowGram 适配边界

日期：2026-09-07。对应问题：[核实 Mastra 官方 AI 工作流构建器与定义约束](../../.scratch/agent-platform/issues/23-mastra-workflow-builder.md)。

结论：**复用 `@mastra/core/workflows/builder` 的 Agent 工厂、编排说明、authoring schema、规范化与 preflight；平台提供只提交草稿的工具，由 FlowGram 承担查看和编辑，发布服务才向 Runtime 注册不可变版本。** 官方已经覆盖了“发现组件 → 生成完整定义 → 校验与修复”的基础契约，可以减少自建工作。它没有替平台实现租户权限、审批、发布、运行预算与版本隔离。

## 证据基线

- 实际安装包：`@mastra/core@1.64.0`，Node `v24.13.0`。读取路径为 `.scratch/agent-platform/labs/skill-sandbox/node_modules/@mastra/core`；未修改该实验或其 Git。
- 官方发布 tag `@mastra/core@1.64.0` 的 annotated tag 为 `9836515a25c1348e7e1fc21598ae94b6e67d6545`，解引用 commit 为 [`c19a93b0956f957581931786645d0597efec41eb`](https://github.com/mastra-ai/mastra/tree/c19a93b0956f957581931786645d0597efec41eb)，由本次 `git ls-remote` 验证。
- 包内 sourcemap 的 builder `agent.ts`、`index.ts`、`preflight.ts`、`authoring-schema.ts`、`authoring-playbook.ts` 与上述 tag 对应源码逐文件比较相等；没有声称整包与整个仓库均已逐字核对。
- 本次进行了确定性 SDK 调用和合成 Tool 工作流执行，探针与原始输出已保存到[独立研究目录](../../.scratch/agent-platform/research/workflow-builder/README.md)，链接见文末。**没有调用真实模型、第三方系统或收费服务，没有证明 AI 生成质量、持久化重启、审批恢复或生产隔离。**
- 官方在该发布 revision 仍将 Dynamic Workflows 标记为 beta，提示可能不随 major 升级发生破坏性变化。[固定版本文档](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/docs/src/content/en/docs/workflows/dynamic-workflows.mdx)

## 可直接复用的公共 API

| API / 内容 | 已核实行为 | 平台接入方式 |
| --- | --- | --- |
| `createWorkflowBuilderAgent({ surfaceInstructions, ...agentConfig })` | 将官方 `WORKFLOW_BUILDER_AUTHORING_PLAYBOOK` 与调用方 surface instructions 拼成 instructions，再创建普通 `Agent`；模型、工具等由调用方提供 | 配置平台许可模型与经过授权过滤的目录工具；不把 factory 当已完成的平台构建器 |
| `WORKFLOW_BUILDER_AUTHORING_CONSTRAINTS` / `WORKFLOW_BUILDER_AUTHORING_PLAYBOOK` | 说明发现依赖、完整定义、数据形状、mapping、控制流及失败修复 | 优先复用；追加草稿、审批、版本和平台能力子集规则 |
| `workflowBuilderDefinitionInputSchema` / `workflowBuilderDefinitionSchema` | 前者允许部分 optional 显式 null、对象形式 mapConfig，适配模型结构化输出；后者为规范存储形状 | 接收完整草稿后规范化，再做严格定义检查 |
| `normalizeWorkflowBuilderDefinition()` | 对象 mapConfig 转 JSON 字符串，去除指定 optional 的 null，拒绝非 JSON 安全对象/函数/循环引用 | 它本身不是完整 schema 校验器，不能只规范化就发布 |
| `preflightWorkflowDefinition(definition, registry)` | 返回 `{ok:true}` 或带路径、错误码、部分修复提示的 issues | 用完整且已授权的 registry snapshot 校验；保留诊断供 FlowGram 与模型修复 |
| `inspectWorkflowBuilderSchemas()` / `compareWorkflowBuilderSchemas()` | 提供图中输出推断及兼容/不兼容/未知结果 | 为变量面板和错误定位提供底层信息；未知不等于已验证兼容 |

上述名称均由固定发布包的公开 `@mastra/core/workflows/builder` 导出核实。该入口唯一 `create*` 工厂为 `createWorkflowBuilderAgent`；它不是其他产品中的 `createBuilderAgent`，也不是旧 `@mastra/agent-builder` 包。实测工厂在未传 tools 时 `listTools()` 为空，不会自动安装保存或执行工具。[入口](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/index.ts)、[工厂](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/agent.ts)、[authoring schema](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-schema.ts)

官方 playbook 假设存在 `list-available-agents`、`list-available-tools`、`list-available-workflows` 三个全量目录工具及一个 surface completion tool。因此平台可保持这三个工具名，但返回**当前身份和项目环境可用、按发布绑定版本过滤后的目录**。若以后采用分页/搜索，必须同步修改说明，不能给模型保留“每类调用一次即完整目录”的错误契约。[固定 playbook](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-playbook.ts)

## 保存、修改与运行确实有副作用

| 官方实现 | 实际行为 | 对本平台的含义 |
| --- | --- | --- |
| Mastra Code `create-workflow` | 调用注册的 `workflow-builder` Agent，并核对 `save-workflow` 的实际成功 tool result；不是只产 JSON | 不直接作为平台“生成草稿”工具复用 |
| Mastra Code `save-workflow` | 调用 `mastra.addDynamicWorkflow()`，保存并替换在线注册；helper 工作流也会成为真实目录资源 | AI 生成不能获得此能力；平台提供 `submit-workflow-draft` 等受控工具 |
| Mastra Code `run-workflow` | 调用运行服务，创建并启动真实 workflow run；使用临时 memory scope 不会消除业务 Tool 的副作用 | “试运行”必须绑定合成/测试工具、位置和权限，不能只换会话 ID |
| `Mastra.addDynamicWorkflow(def)` | 单定义完整 upsert；相同 ID 替换已有定义和在线注册 | 平台发布应使用独立版本 ID/绑定，不能直接覆盖逻辑 ID 作为版本机制 |
| `Mastra.addDynamicWorkflows(defs)` | 校验整个 bundle、按 nested dependency 拓扑注册，再逐条写 storage；失败回滚内存注册 | storage 中途失败仍可能部分写入，不等于平台原子发布事务 |

来源：[Code 创建工具](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/mastracode/sdk/src/tools/workflows/create-workflow.ts)、[保存工具](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/mastracode/sdk/src/tools/workflows/save-workflow.ts)、[运行工具](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/mastracode/sdk/src/tools/workflows/run-workflow.ts)、[addDynamicWorkflows 实现](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L5013-L5182)。

Core factory 不包含定义注册、局部修改或试运行工具。官方 schema 注释提到 Studio 的 `submit-workflow-draft` 与 Ready 后显式保存的 surface；本次没有取得并验证其完整 UI/服务实现，**仅据此确认共享契约有意把草稿与立即保存分开，不能声称已有可直接安装的 FlowGram 草稿工具套件**。[schema 的 surface 说明](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-schema.ts#L1-L24)

配置 schedule 也不是纯视觉元数据：rehydrate 会选 evented engine，成功注册后可能同步声明式 schedules。首期草稿工具应拒绝未经支持的 schedule，发布才允许授权调度。没有配置持久 storage 时，本次 SDK 警告回退到内存存储；新 Mastra 实例无先前注册定义，不能把成功返回理解为重启后可恢复。[rehydrate](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/rehydrate.ts#L65-L104)、[注册后的 schedule 同步](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/mastra/index.ts#L5164-L5181)

## 定义、依赖与 FlowGram 图形的对应

规范定义包含 `id`、输入/输出 JSON Schema、顺序 `graph`，以及可选 description、metadata、stateSchema、requestContextSchema、schedule。可编排类型为 agent、tool、mapping、workflow、parallel、foreach、sleep、sleepUntil、conditional、loop。**这是有序结构化图，不是任意边构成的自由 DAG。** closure、自定义 JS 函数不属于 authoring 子集。[入口类型](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/index.ts)

- Agent / Tool / nested workflow 必须解析到目标 Mastra 实例已注册资源，或同一 bundle 中的 helper。资源目录不能由模型编造。工具按 Mastra tools registry key 解析；Agent 与 nested workflow 的 intrinsic ID 需按实际注册方式一致处理。[官方依赖说明](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/docs/src/content/en/docs/workflows/dynamic-workflows.mdx#L116-L124)
- `workflowId` 是依赖 ID，节点 `id` 是本图调用点 ID，可不同。发布版会克隆 nested workflow 以调用点 ID 执行；下游 mapping 使用调用点 ID。合成 SDK 已验证 `[root, helper]` 倒序 bundle 注册及调用点结果投影。[rehydrate](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/rehydrate.ts#L174-L181)
- parallel/conditional 的 children、foreach/loop 的 body 仅允许 agent、tool、nested workflow。mapping 必须是顶层线性步骤，不能直接塞进这些容器；复杂分支需 helper 子工作流。[authoring 约束](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-playbook.ts)
- 平台建议：FlowGram 的连线、容器和节点属性受此编译子集约束，布局单独保存。保留稳定节点 ID 以连接版本差异、preflight issue path 与运行事件。不能静默丢掉不能编译的边或节点。

## mapping 与条件不执行自由代码，但校验仍有缺口

mapping 规范形式为 JSON 字符串；每个输出字段只能选择一种来源：`{value}`、`{template}`、`{initData:true,path}`、`{step,path}`、`{requestContextPath}`。模板支持 `${inputData...}`、`${initData...}`、`${stepResults.<id>...}`、`${state...}`、`${requestContext...}`。它执行路径读取与字符串转换，没有 JS `eval`/自由算术表达式能力。条件是声明式 predicate DSL，支持比较、成员判断、存在性、truthy/falsy、and/or/not；Workflow predicate 的上下文是 initData、inputData、state、stepResults，不能把 mapping 支持 requestContext 误推为 predicate 也支持它。[mapping 分析](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/mapping-config.ts)、[模板解释器](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/mapping-template.ts)、[predicate DSL](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/predicate/index.ts)、[Workflow predicate 上下文](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/predicate/index.ts)

**实际反例：** `${initData.n + 1}` 在 `n=3` 时，preflight 返回 ok，实际输出空字符串，未得到 `4`。原因是模板把 `n + 1` 当字段名，缺失值转为空字符串。不能承诺官方 preflight 已拒绝所有“看起来像表达式”的写法；平台应添加严格路径语法和已知字段检查。需要运算时使用已注册确定性 Tool，而不是开放模型生成 JS。此反例只是功能验证，不是完整模板安全审计。

Agent 节点固定消费 `{prompt:string}`，默认产出 `{text:string}`；step-level outputSchema 可改成结构化输出。相邻步骤不自动做字段转换，容器也不会自动把分支输入包装成各自所需形状。[官方 playbook](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-playbook.ts)

## 控制流与预算

| 能力 | 固定版行为及本次证据 | 首期平台约束建议 |
| --- | --- | --- |
| conditional | 所有 predicate 按索引判断，**所有命中分支并行执行**；实测两个条件同时为真时两个工具均执行，峰值并发为 2 | UI 不能显示成默认互斥 if/else；若提供单选分支，必须编译成互斥 predicates 并验证 |
| foreach | 输入必须是裸数组；每项直接给 body；输出数组保序。默认 concurrency=1，配置 2 实测峰值 2、结果顺序不受完成先后影响 | 发布限制 concurrency；执行边界限制输入项数、字节数、单项和总预算 |
| foreach 上限 | authoring schema 是正整数，未设业务最大值；100000 可通过 schema。运行 resolveConcurrency 也未加入统一最大值 | 不能用 SDK 默认能力承诺并发配额；平台按环境配额验证和计费 |
| loop | `dowhile` / `dountil` 均先执行 body，再判断；后次输入为自身上次输出。实测 dountil 到 3 执行 3 次，dowhile 判 false 仍执行一次 | body 的输出须满足下一轮输入；区分“先检查条件”的用户预期 |
| loop 预算 | authoring loop 无 `maxIterations` 字段，添加该字段会被 strict schema 拒绝；默认引擎循环实现无原生次数上限，支持迭代之间检查取消信号 | 循环预算、超时、外部副作用取消由平台执行契约实现；未完成可验证预算前不要开放任意 loop |

来源：[authoring concurrency 与 loop schema](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/authoring-schema.ts)、[默认引擎控制流](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/handlers/control-flow.ts#L305-L861)、[foreach concurrency 解析](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/utils.ts#L786-L796)。

**不能依赖动态 JSON Schema 的 `maxItems` 实现输入上限。** 1.64.0 的内置 JSON Schema→Zod converter 只实现部分关键字；实测 `{type:'array',maxItems:1}` 仍接受两项，`{type:'number',minimum:10}` 仍接受 `1`。`anyOf` 等特定不支持关键字会被 preflight 拒绝，但不意味着其余关键字都已执行。平台需要独立、覆盖实际 schema 方言的边界校验和预算检查；不能只在图上填上限。`additionalProperties:false` 的转换也使用普通 Zod object，不应假设为严格拒绝额外字段。[转换实现](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/json-schema-to-zod.ts)

## preflight 通过不等于可发布

实际探针给同一个不存在的 `toolId`：不传 registry 时 `{ok:true}`；传 `{agents:{},tools:{},workflows:{}}` 时返回 `missing-reference`。这是官方有意按 registry kind 是否提供而决定检查，schema 缺失也会使兼容性分析降为 unknown。[preflight](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/builder/preflight.ts)、[引用检查](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/validate/refs.ts)、[schema-flow](https://github.com/mastra-ai/mastra/blob/c19a93b0956f957581931786645d0597efec41eb/packages/core/src/workflows/dynamic/validate/schema-flow.ts)

建议平台发布门依次执行：authoring schema → canonical normalization/schema → 完整授权 registry preflight → 平台能力和字段限制 → 版本与位置绑定 → 内容/model/tool/Skill 权限 → 合成或获准调试 → 审阅发布。把官方 issue 的路径和 repair 提示用于修复交互；这些 repair operation 名称是诊断数据，**并非 factory 自动安装的可调用 mutation tools**。

这一流程与当前产品决策一致：已授权版本范围内 Skill 自主执行；业务写工具默认动作确认，客户可预授权；生成/修改工作流不能顺带获得写工具或内容出域权限。

## 最小后续原型

1. **草稿闭环：** 一个共享定义依次经历 AI 候选（先可用确定性模拟结果）、平台 submit-draft、FlowGram 展示/修改、再次校验；审阅前 Runtime registry 不变化。后续真实模型接入再单独评估生成成功率和修复轮次。
2. **数据语义：** 串行 tool→mapping→agent、parallel 汇总、多条件同时命中、foreach 保序及 helper 子流程；FlowGram 回读不丢 ID/条件/调用点 mapping。对不支持的容器嵌套和表达式明确报错。
3. **发布版本：** root+helper 版本 bundle、注册失败和存储部分写入、同名编辑对新旧 run 的影响、重启加载与恢复。官方文档描述“已开始 run 保留原图”尚不能替代本平台版本绑定及恢复验证。
4. **边界强制：** 超过 foreach 项数/并发、超时/循环预算、缺失或被撤销依赖、未获准业务写入。运行预算需覆盖 helper 与 Agent 工具调用，不仅覆盖 FlowGram 外层节点。

以上为下一实验建议；本轮完成的是官方固定源码研究与下述本地确定性探针，未完成 FlowGram 集成或发布实现。

## 本次 SDK 探针摘要

退出码为 0；没有模型调用。验证了公共导出、空默认工具集、规范化、缺失 registry 的差异、anyOf 拒绝、容器 mapping 拒绝、loop 额外预算字段拒绝、函数拒绝、模板非算术、foreach 默认与指定并发/保序、conditional 多命中、两种循环语义、bundle 拓扑/调用点 mapping、无效引用注册不改变目录、无持久存储的新实例无先前工作流。

最初在临时目录运行；保存到工作区后改用相对依赖路径，并用 `node probe.cjs` 复验。共记录 **22 项发现**，脚本退出码为 0。

[完整探针](../../.scratch/agent-platform/research/workflow-builder/probe.cjs)、[原始 JSON 结果](../../.scratch/agent-platform/research/workflow-builder/probe-result.json)。独立研究仓库的 `research/workflow-builder` 分支保存代码与结果；脚本创建的资源只存在于本进程内存 Mastra 实例中。
