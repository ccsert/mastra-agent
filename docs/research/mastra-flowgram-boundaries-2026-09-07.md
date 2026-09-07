# Mastra 与 FlowGram 的能力边界

核查日期：2026-09-07。仅依据官方文档、官方源码；未安装依赖或运行原型，以下是架构讨论依据，不是生产验收结论。

## 已确认事实

**FlowGram 包含服务端执行能力。** 官方仓库提供 runtime-interface、runtime-js、runtime-nodejs；Node.js 服务采用 Fastify，暴露 tRPC/OpenAPI。其 WorkflowSchema 是 `nodes/edges/groups/globalVariable` 图结构。服务端校验覆盖格式、环、边端点、起止节点及输入 JSON Schema；这不代表已覆盖租户权限、工具授权与业务语义。[Runtime](https://github.com/bytedance/flowgram.ai/tree/main/packages/runtime)、[服务端](https://raw.githubusercontent.com/bytedance/flowgram.ai/main/packages/runtime/nodejs/src/server/index.ts)、[Schema](https://raw.githubusercontent.com/bytedance/flowgram.ai/main/packages/runtime/interface/src/schema/workflow.ts)、[校验源码](https://raw.githubusercontent.com/bytedance/flowgram.ai/main/packages/runtime/js-core/src/domain/validation/index.ts)。

**编辑器与执行引擎可分层选用。** 官方定位是搭建平台的工具包；其示例 WorkflowApplication 用进程内 Map 保存 task，不能据此认定已有生产持久化调度平台。本轮未找到官方 Mastra adapter，直接互通未确认。[定位](https://github.com/bytedance/flowgram.ai)、[执行入口](https://raw.githubusercontent.com/bytedance/flowgram.ai/main/packages/runtime/js-core/src/application/workflow.ts)。

**Mastra 已原生支持数据定义的动态工作流。** 2026-08-12 公告要求 core ≥1.58.0；当前仍为 beta，可无主版本升级而破坏兼容。JSON 可来自 LLM/画布，`addDynamicWorkflow()` 或 `POST /api/stored/workflows` 负责校验、热注册与存储；重启加载依赖存储适配器支持 workflowDefinitions。引用的 agent/tool/workflow 必须预注册。[公告](https://mastra.ai/blog/introducing-dynamic-workflows)、[动态工作流](https://mastra.ai/docs/workflows/dynamic-workflows)。

**Mastra 定义不是任意节点边图。** graph 是有序、嵌套控制流，支持 agent/tool/mapping/workflow、并行、条件、foreach、循环及 sleep；conditional 会并行执行所有条件为真的分支。更新定义后新 run 用新图，已启动 run 继续原图；跨重启后的旧版本恢复仍应验证。[定义参考](https://mastra.ai/reference/workflows/dynamic-workflow-definition)、[更新语义](https://mastra.ai/docs/workflows/dynamic-workflows#replace-a-workflow)。

**快照恢复不等于多副本调度已闭环。** suspend/resume 支持持久化后跨重启恢复。Durable Agent 文档同时出现“恢复持有 lease”和“尚无分布式 lease/lock，多个副本会竞争”的矛盾说明；本轮将多副本恢复协调标为未确认。官方明确恢复可能重发模型请求及工具调用，业务副作用需要幂等。[工作流恢复](https://mastra.ai/docs/workflows/suspend-and-resume)、[Durable Agent 恢复](https://mastra.ai/docs/harness/durable-agents#crash-recovery)。

## 架构建议（推论，待决策）

采用“画布或 AI → 统一受限 Workflow Definition → 校验与版本发布 → Mastra adapter → runtime”。控制面拥有目录、权限、审批、版本和发布记录；runtime 执行固定版本、解析凭据引用并回传事件。优先适配 Mastra 原生动态定义，避免先重造通用执行器；FlowGram 保存布局元数据，节点限定为可映射的结构化控制流，不承诺任意 DAG 无损转换。

“AI 自动编排”分三层：①设计时生成/修改定义，经校验发布；②固定图中的 agent 在授权工具内动态选择行动；③执行中根据结果重新规划后续步骤。建议先交付①②；③另行定义计划版本、已完成步骤保留、审批与补偿规则，不能把热更新定义当作运行中改图。

## 三个关键 PoC

1. 画布↔定义↔Mastra 往返：分支汇合、嵌套 foreach、变量映射、节点 ID 与运行轨迹一致；拒绝不支持图形。
2. 双 runtime 故障：执行副作用后强杀、并发恢复、重复审批回调、发布 v2 后恢复 v1；验证无重复业务动作、版本不漂移、事件可续传。
3. AI 编排：自然语言生成并修改同一定义；注入不存在工具、类型错配、越权引用、无界循环，验证拒绝/修复闭环与预算边界。
