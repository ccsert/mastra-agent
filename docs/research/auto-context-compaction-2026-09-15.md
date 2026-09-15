# 会话历史自动压缩 · 交付

基于 `71ae081`，补上 Mastra Observational Memory 式「按 token 阈值自动压缩」的缺口。设计依据见 [Mastra Memory 文档](https://mastra.ai/en/docs/memory/observational-memory)调研（本地对照结论：整体引入 `@mastra/memory` 会夺走控制面对历史的主导权，只吸收阈值触发设计）。

## 方案

`createRun` 计算 `compact` 时新增自动判定：取该会话**最近一次实测模型请求的 inputTokens**（`run_events` 的 `data-model-step`，按 run 时间倒序取最后一条），达到 Agent 上下文窗口的 **75%** 即自动挂 `context_action='compact'`。复用既有分段摘要流程——先摘要历史、再用压缩后的上下文正常回答，用户照常收到回复。

- 手动 `/compact` 行为不变（仍可强制、可带关注点）。
- 自动压缩是**尽力而为**：历史超过压缩预算（100 万字符）时跳过压缩继续正常回答，不阻断用户消息（与手动路径的显式报错区分开）。
- 查询走既有 `runs_conversation_page_idx(conversation_id, created_at DESC, id DESC)` 与 `run_events` 主键，热路径无新增索引需求。

## 验证

- 集成测试：低于阈值不挂压缩、超过 75%（25,000 / 32,000）自动挂 `context_action='compact'`、跨账号拒绝。
- 真实数据复核（只读查询）：失败过的「真实网页任务」会话峰值 **34,816 tokens**，超过 32k 窗口——正是它此前 `TOKEN_BUDGET` 失败的原因；75% 阈值（24,000）会提前触发压缩。其余会话峰值 6.5k–21k，均在阈值下，不会误触发。
- 顺带修复：新增的自动压缩测试会留下一个未取消的 queued run，被后续 leases 测试 `queue.claim()` 抢走（表现为该测试全量运行失败、单跑通过）；已在测试内取消，`leases`/`derive`/`auto-compact` 三个测试同跑通过。
- `pnpm check` 退出码 0：后端/协议 156 通过、4 跳过，Console 172 通过。

## 边界

- 阈值固定为窗口的 75%，未做按模型动态调整；`contextTokens` 未配置时按既有默认 32,000 计算。
- 判定依据是「上次请求实测用量」，新会话或未跑过的会话不触发。
- 自动压缩会消耗一次（或多次）模型调用生成摘要，属预期成本；压缩记录仍完整保留，可追溯。
