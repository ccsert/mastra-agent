# Agent 运行轨迹可观测性补齐方案

日期：2026-09-11。接续[运行轨迹透明度修复](../research/trajectory-transparency-fix-2026-09-09.md)、[会话多轮轨迹与运行记录合并](../research/conversation-trajectory-2026-09-09.md)与 [DSH 本地对照](../research/dsh-local-trajectory-2026-09-09.md)。状态：**P0 采集层已实施，读取与界面升级待做**。实施记录与验收见[轨迹采集 P0](../research/trajectory-collection-p0-2026-09-11.md)；其中修正了本文对上游能力的假设（用量与关联键无需从零采集），授权决策落库仍为未完成项。

## 结论

现在的轨迹是「把流式事件投影出来」，不是「Runtime 在真实执行点记录事实」。它能回答**发生过什么、顺序如何**，不能回答**花了多久、用了多少 token、重试了几次、为什么失败、跨系统怎么对上号**。

缺的不是界面，是**采集点**。界面层已经做过一轮收敛（分类、检查器、会话轮次合并），继续在投影侧加工只能把同一份事实重新排布；要变厚必须先让 Runtime 和授权路径产出新事实。

## 现在能追溯到什么

事实基线，用于后续判断哪些缺口是「没采集」而不是「没展示」：

- 事件存储：`run_events(run_id, seq, chunk jsonb, created_at)`，`chunk` 是 AI SDK 的 `UIMessageChunk` 原样落库，外加一个自定义的 `data-model-request`。append-only，`PRIMARY KEY(run_id, seq)`。
- 模型请求正文：`tracedModelFetch` 在 provider 的实际 fetch 边界抓 `model / messages / tools / tool_choice / temperature / max_tokens`，带 `transient` 标记，不抓认证请求头与 URL 凭据。
- 时间：唯一来源是控制面**收到事件**时的 `created_at`。`traceDuration()` 明确标注为「接收跨度」。
- 工具调用：由 `tool-input-available` / `tool-output-available` 归并出状态，没有独立生命周期。
- 运行终态：`runs.status / error_code / output_text / finished_at`。
- 会话读取：`getConversationTrace` 每轮最多 501 条事件，超出只置 `hasMoreEvents`，没有继续读取的通道。
- 已有对照物：工作流已经用 `workflow_node_runs` 记录每个节点的真实 `started_at / finished_at / error_code`。**Agent 运行没有等价物**，这是不对称的。

## 四类缺口

| 类别 | 现在缺什么 | 为什么现在看不到 | 需要在哪个采集点补 |
| --- | --- | --- | --- |
| 观测完整性 | token 用量、模型原生耗时、首 token 时延、工具真实执行时长、排队/领取/心跳分解 | 采集点只有流式文本与工具 chunk，没有度量字段 | Runtime 的模型响应与工具执行边界 |
| 因果完整性 | span 父子关系、请求生命周期、重试与 attempt、失败阶段分类、并行与嵌套 | 归属靠「顺序 + 相邻」启发式推断；重试会表现为又一个 `data-model-request` | Runtime 生成 span id 与 request id |
| 治理完整性 | 授权/拒绝决策本身、知识命中与检索参数、内容处理许可留痕、跨系统关联键 | 权限判定发生在控制面，但没有作为事件落库，只能从调用成功反推 | 控制面的授权与检索路径 |
| 读取与边界 | 500 条之后的续读、正文脱敏与保留期、超长轨迹虚拟化、历史字段的永久缺失清单 | 存储层整条 chunk 原样入库；读取层一次性切片 | 存储策略 + 读取游标 |

几处具体表现：

**观测。** 全项目搜索 `usage / inputTokens / outputTokens / ttft` 没有任何命中——Token 与首 token 从未被采集。检查器的「计时」页已经诚实地写明来源是控制面接收时间戳，这不是展示缺陷，是事实缺陷。

**因果。** `toolOwners()` 用「上一个非工具记录是不是同轮的模型记录」来判断工具属于哪次调用。这个启发式在多工具并行、模型只返回工具调用无正文、或一次模型输出挂多个工具时都会失准。真正的父子关系应该由 Runtime 给出。

**治理。** 一次运行里「谁授权了这次 MCP 调用 / Skill 脚本执行 / 动作批准，范围是什么」没有独立记录。当前只能从调用成功推断授权存在；被拒绝的调用也只能看到一个错误码，看不到依据。

**读取。** `LIMIT 501` 加上一个布尔标记，导出时标「不完整」，但没有「继续读」的入口。历史运行恢复依赖不可变快照或 SHA-256 精确匹配——这个「不伪造」的取舍是对的，但需要一份明确的**永久缺失字段清单**，否则用户无法判断「看不到」是权限问题、是分页问题，还是本来就没记录。

## 建议的改动

### 采集与契约

沿用 append-only 的 `run_events`，不改 `seq` 语义，新增事件类型：

- `run.started` / `run.finished`：Runtime 侧的单调时钟 + 墙上时钟，用于把端到端拆成排队、领取、执行。
- `model.request.start` / `model.request.first-token` / `model.request.finish`：含 `requestId`、`attempt`、`model`、`usage`、`finishReason`、`errorPhase`。重试是同一个 `requestId` 的不同 `attempt`，不再是一条新请求。
- `tool.call.start` / `tool.call.finish`：含 `toolCallId`、`spanId`、`parentSpanId`、`durationMs`、`resultSize`。这是 `workflow_node_runs` 在 Agent 路径上的对应物。
- `authz.decision`：主体、动作、资源、范围、结果、依据。由控制面的 MCP / Skill / 动作批准路径产出。

`runs` 表增列或加侧表：用量汇总、端到端分解、attempt 总数、可用于跨系统对齐的 `traceId`。`run_events` 补 partial index 支撑按类型查询。

### 读取模型

`getConversationTrace` 增加：真实时间轴（**有真实 span 才画**，没有就保持等宽调用顺序）、用量与耗时汇总、重试与并行关系、按 span 定位。事件读取从「LIMIT 501 + 布尔」改为游标续读，`hasMoreEvents` 保留为兼容字段。

前端 `projectTimeline()` 的 `sequence` / `duration` 两种模式保持不变，`duration` 模式的注释要从「接收跨度」改为真实 span 后更新，避免语义漂移。

### 兼容原则

延续已有的「历史运行不伪造」：没有真实 span 的旧运行继续显示接收跨度，**不重算、不回填**。新旧两套在同一界面共存，由来源标注区分——这个模式在系统提示词的处理上已经验证过（「Runtime 实际模型请求」 vs 「发布版本快照」）。

## 分期

- **P0｜先补采集，界面不动**：Runtime 记录模型请求生命周期与 usage、工具执行开始/结束、控制面记录授权决策；事件类型与 OpenAPI 落地。这一期结束前界面表现不变，但数据已经变厚。
- **P1｜读取模型升级**：真实时间轴、汇总统计、重试与父子关系；事件游标续读。
- **P2｜边界与规模**：超长轨迹虚拟化、脱敏与保留期策略、跨系统 trace id 贯通。

## 不做与不声称

- 不用控制面接收时间冒充模型推理耗时。
- 不为缺失字段填充估算值或样例值。
- 不因补齐观测而扩大正文访问权限；新增字段沿用现有项目、租户、用户与调用入口边界。
- 不宣称覆盖非 OpenAI-compatible 协议的用量与首 token 语义。
- P0 完成不等于观测闭环完成：没有读取模型消费，新事件只是躺在表里。

## 验收建议

用内网 Qwen 跑一次「一次工具调用 + 一次故意失败请求」的合成会话，断言：

1. `usage` 与首次真实耗时存在，且来源标注指向 Runtime 而非控制面接收时间。
2. 失败请求带 `errorPhase` 与 `attempt`，且不产生伪成功的记录。
3. 工具调用有真实 `durationMs`，与 `workflow_node_runs` 的语义一致。
4. 旧运行仍显示「接收跨度」，未被重算。
5. 授权决策事件与实际调用结果能对上号。
