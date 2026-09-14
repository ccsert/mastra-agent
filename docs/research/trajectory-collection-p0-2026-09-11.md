# 轨迹采集 P0：模型时序、工具执行与运行用量

日期：2026-09-11。实施[可观测性补齐方案](../planning/trajectory-observability-proposal.md)的 P0（只补采集，界面不变）。接续[会话多轮轨迹与运行记录合并](conversation-trajectory-2026-09-09.md)。

## 主要发现：指标本来就在，只是被丢掉了

方案假设用量、耗时、关联关系都要从零采集。核查上游之后结论不同：

- AI SDK 完整流的 `finish-step` 片段带着 `usage` 与 `performance`，后者含 `stepTimeMs`、`responseTimeMs`、`timeToFirstOutputMs`（首 token 时延），以及按 `toolCallId` 索引的 `toolExecutionMs`。
- 这些字段在 `toAISdkStream` 转成 UI 消息流时被丢弃：UI 流的 `finish-step` 与 `finish` 是不带字段的空片段，而平台只持久化 UI 流。
- Mastra 的 `MastraModelOutput` 另以 Promise 形式暴露 `usage`、`totalUsage`、`steps`、`finishReason`、`traceId`、`spanId`。它们不参与流消费，因此可以旁路读取。

所以 P0 不是新建计时器，而是**换一个读取位置**：语义事实取自 Mastra 的返回对象，传输事实在 provider 的 fetch 边界自测。

另有一处与方案假设不同的实现细节：本版 Mastra 不把 `toolCallId` 放在工具执行上下文的顶层，而是放在 `context.agent.toolCallId`。

## 落地内容

1. **事件带 Runtime 时间**。`run_events` 新增可空列 `occurred_at`（迁移 9）；`RuntimeEventInput` 增加可选 `occurredAt`（带时区偏移的 ISO 8601）。Runtime 在 `onChunk` 被调用那一刻打时间戳，而不是排队投递到达网络的时刻。读取时 `RunEvent` 返回 `occurredAt` 与 `timeSource`：有 Runtime 时间即为 `runtime`，没有则回退到控制面接收时间并标为 `control-plane`。旧行不回填、不重算。
2. **模型请求的两端时序**。`tracedModelFetch` 记录 `startedAt`、`responseAt`（响应头到达）、`firstByteAt`、`completedAt`、`durationMs`、`firstByteMs`、`responseBytes`、`httpStatus` 与 `outcome`。响应体通过逐个 chunk 拉取来观测，保压不变——慢读端不会让 Runtime 为测量而缓存整个补全；内容不被解析，请求与响应头都不复制。`firstByteMs` 是**首个响应字节**，不是 token 级首 token 时延。
3. **工具执行时长**。Runtime 自己构造的工具被逐个包装，事件带模型自己的 `toolCallId`、来源（`sum`/`http_get`/`mcp`/`skill`/`knowledge`）、起止、`durationMs`、结果与已识别的错误码。只记录 `McpErrorCode`/`SkillErrorCode` 中的已知码，不复制错误文本。
4. **运行用量**。流结束后读取 `totalUsage`、`steps`、`finishReason`、`traceId`、`spanId`，连同按位置对齐的每步用量与模型 id。等待有 2 秒上限，失败的流不能因为读数而挂住整个运行。失败的运行同样上报（投递信号仍有效）；取消的运行会中止投递，因此不产出该事件，而不是产出半份读数。
5. **观测永不改变运行结果**。三处采集的校验与投递失败都在内部吞掉。代价是"观测缺失"表现为缺失而不是错误；这是刻意的，也是本方案"不伪造"原则的直接体现。

契约集中在 `packages/contracts/src/trajectory.ts`，Runtime 在发出前用它们自校验。

## 明确未做

- **授权决策没有落库**。方案 P0 中的 `authz.decision` 未实现。它需要新表、写入 MCP / Skill / 知识检索三条授权路径并在读模型里合并，属于安全敏感改动，不在本轮赶工范围内，作为 P0 的剩余项保留。
- **Mastra Workspace 提供的工具没有计时**。`skill`、`skill_read`、`skill_search` 由 Mastra 的 Workspace 在内部创建，不在 Runtime 构造的工具集合里。已计时的是 `run_skill_script`（真正的沙箱执行）、平台工具与 `knowledge_search`。
- **AI SDK 的 `performance` 指标未使用**。`stepTimeMs`、`timeToFirstOutputMs`、按 `toolCallId` 的 `toolExecutionMs` 仍在被丢弃。P0 用自测的传输时长替代，语义更保守（首个字节而非首 token）。
- **新事件在界面上不可见**。轨迹视图不消费 `data-model-response`、`data-tool-execution`、`data-run-usage`，界面表现与本轮之前一致；数据已可通过 `listRunEvents` 与 `getConversationTrace` 读取。
- **观测载荷不在 OpenAPI 文档里**。事件正文位于 `chunk: object` 之内，因此 `ModelRequestTiming`、`ToolExecution`、`RunUsage` 目前只在 TypeScript 与运行时校验层面成立，要等有路由暴露它们（P1）才会进入规范。
- **未接真实模型**。本轮验收全部使用确定性的 OpenAI 协议夹具，没有对内网 Qwen 执行会话。

## 验收证据

迁移：`pnpm db:migrate` 应用版本 9，`run_events` 出现 `occurred_at`。

新增 `tests/runtime/agent-trace.test.ts`（5/5）：

- 流式响应原样透传，同时被计时与计字节；
- 取消的响应记为 `incomplete`，不会表现为完成；
- 没有产生响应的请求记为 `failed`，而不是被省略；
- 非 JSON 请求体不再被当作模型请求（此前未加保护的 `JSON.parse` 会直接抛出）；
- 每次传输调用都被编号，使响应总能对上请求。

端到端（`tests/integration/integration.test.ts`，SDK → 控制面 → HTTP worker → Mastra → 事件落库）：

- 每个事件的 `timeSource` 都是 `runtime`，`occurredAt` 非空。
- `data-model-response` 数量等于夹具实际收到的模型调用数，全部 `completed`、`httpStatus` 200、`responseBytes > 0`，测得首个字节且 `durationMs >= firstByteMs`。
- 恰有一条 `data-tool-execution`：`toolName` 为 `sum_values`、来源 `sum`、结果 `succeeded`，且其 `toolCallId` 与模型流出的 `tool-input-available` 的 `toolCallId` 相等——即与模型侧精确对上，而非按顺序推断。
- 一条 `data-run-usage`：`steps` 为 2，`perStep` 长度等于 `steps`，运行总量等于单次调用的 128 乘以步数（`totalUsage` 是跨步累加，不是最后一次调用），每步都带模型 id。

夹具改动：流式分支补发了 OpenAI 在 `stream_options.include_usage` 下返回的末尾 usage 片段，使用量映射得到实际覆盖。

检查：`pnpm lint`、`pnpm architecture:check`、`pnpm build`、`pnpm sdk:check` 通过；`pnpm test` 52 项、50 通过、2 跳过（跳过项为需要专用镜像的 Docker 沙箱测试，本轮不计为通过）。生产构建仍有此前的大 chunk 提示。

## 读取模型的迁移注意

`RunEvent` 新增两个必填字段，任何构造该对象的调用方都需提供。控制面读模型统一走 `runEventDto`，旧行因此读回的是接收时间而非 Runtime 时间；界面与 SDK 消费者不应把两者混为一谈。

## 下一步

P1：读取模型升级——把 `occurredAt` 用于轨迹时间（界面目前仍用接收时间），消费用量与工具时长，并在有真实 span 后改画时间轴。

P0 剩余项：授权决策落库。
