# 控制台对话与轨迹界面优化审计

日期：2026-09-10。基线：`6a2ff15`（会话多轮轨迹合并）。本记录先给出对照 DeepSeek Harness（下称 DSH）的界面差距与优先级，再说明本轮已落地的改动。参照对象为本地 DSH 检出 `/Users/ccsert/project/dsh/deepseek-harness`，重点包 `packages/client/ui-chat`、`ui-conversation`、`ui-tool`、`ui-trajectory`。

本轮开始前：只做代码与真实页面基线截图核对。本轮随后在本地启动了完整平台（console 5179 / 控制面 4110 / runtime 4112），用浏览器登录后实际查看了多轮会话的对话与轨迹页，并核对时长模式与消息复制。基线截图见 `output/visual-design/2026-09-09/current-chat.png` 与 `current-trace.png`（注意这两个文件实际是 JPEG，扩展名与内容不符）；本轮核验截图在 `output/visual-design/2026-09-10/`（被 Git 忽略）。

## 本轮已落地

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 轨迹投影与合并结果记忆化 | `apps/console/src/features/runs/ConversationTrace.tsx` | `turns`、`merged`、`records` 改为 `useMemo`；轮询、选中、输入搜索不再重复执行 `projectConversation`。流的尾部用 `tailsKey` 签名加 ref 读取，避免 `useQueries` 每帧重建数组导致缓存失效。 |
| 搜索索引与分类投影只算一次 | `ConversationTrajectory.tsx` | 搜索文本按 `records` 记忆化，输入时不再对每条记录 `JSON.stringify`；三条概览轨道改为一次投影。 |
| 概览改绝对定位时间带 + 接收时长模式 | `trajectory.ts`、`ConversationTrajectory.tsx`、`styles.css` | 见下节“轨迹 #1”。 |
| 轨迹记录序号 | `ConversationTrajectory.tsx`、`styles.css` | 每行左侧显示 `#N`，与 DSH 记录序号一致。 |
| 分类筛选补“错误” | `ConversationTrajectory.tsx`、`trajectory.ts` | `traceCategories` 统一分类，错误记录不再只能在“全部”里看到。 |
| 消息复制与回到底部 | `apps/console/src/features/chat/Chat.tsx`、`styles.css` | 用户与助手消息挂 `ActionBarPrimitive.Copy`；视口滚离底部时显示浮动的“回到底部”。 |
| 记录列表虚拟化 | `ConversationTrajectory.tsx`、`styles.css` | 超过 100 条记录时只渲染视口窗口（固定 44px 行、overscan 12），画布按 `记录数 × 44px` 占位；短轨迹仍全量渲染，保持搜索与 DOM 断言简单。未引入 `@tanstack/react-virtual`，用等行高手写窗口。 |
| 向前分页保持滚动位置 | `ConversationTrajectory.tsx`、`ConversationTrace.tsx` | “加载更早轮次”移到记录列表顶部；插入前记录 `scrollHeight/scrollTop`，插入后按高度差恢复，避免阅读位置跳走。 |
| 空会话不再堆积 | `conversations.ts`、`Agents.tsx` | 见下节“会话生命周期”。 |
| 首条消息自动命名 | `conversations.ts`、`records.ts` | 见下节“会话生命周期”。 |
| 删除会话 | `conversations.ts`、`routes.ts`、`ChatWorkspace.tsx` | 见下节“会话生命周期”。 |
| 退役“运行记录”入口 | `navigation.tsx`、`Runs.tsx` | 见下节“运行记录”。 |
| 轨迹两级折叠 | `trajectory.ts`、`ConversationTrajectory.tsx`、`styles.css` | 见下节“轨迹 #T6”。 |

验证：`pnpm test:console` 49/49、后端 `pnpm test` 45 通过/2 跳过（Docker 沙箱）；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check`、`pnpm sdk:check` 通过。浏览器实机核验：多轮会话轨迹 11 条记录序号、分类、时长模式与来源标注正常；两级折叠与时间带自动展开定位正常；对话页复制按钮悬停可见；`/runs` 跳转到 `/chat`；空会话从列表隐藏；重复“对话”复用同一条记录；通过界面确认删除后会话、消息与运行记录一并删除。

## 会话生命周期（本轮修复）

用户反馈：点“对话”立即产生空会话、越积越多、不能删除、标题不会自动生成。根因是 `AgentCollection.startChat` 每次调用 `createConversation` 并立即落库，且标题写死为 Agent 名；`list` 不做任何过滤；没有删除接口。修复：

- **复用未使用的占位会话**：`Conversations.create` 先查同一 actor/entry/agent 下没有运行记录的会话；存在就更新发布版本与标题后返回，否则才插入。重复点“对话”不再产生新行。
- **列表隐藏未使用的会话**：`list` 只返回至少有一次运行的会话。已存在的 14 条历史空会话因此从界面消失（数据仍在，可在需要时清理）。
- **首条消息命名**：`createRun` 写入用户消息后，若标题仍是 `新会话` 或空，则用输入的首行（压缩空白、截断 30 字）更新标题。
- **删除**：新增 `DELETE /api/v1/projects/{projectId}/conversations/{id}`（`deleteConversation`），事务内按 `run_events → messages → runs → conversations` 顺序删除，正在运行的会话返回 `CONVERSATION_BUSY`。与 `cancelRun` 一样要求 JSON 空对象，否则 SDK 不会带 `content-type` 而被中间的 JSON 守卫拒绝。前端在会话项悬停时显示删除按钮，`Popconfirm` 二次确认。
- **Agent 卡片**改为用占位标题 `新会话` 创建，命名交给首条消息。

实机验证：同一 Agent 连续两次创建返回同一 id；列表计数不变；通过界面删除后数据库 `conversations`、`runs` 均为 0 行。

### 轨迹 #T6：两级折叠

`trajectory.ts` 新增纯函数：`toolOwners` 把紧跟某个模型记录的同轮工具归到该模型下；`turnGroups` / `callGroups` 给出可折叠的轮次与调用组；`foldTrace` 用合成摘要行替换被折叠的记录；`unfoldTarget` 反查某条记录所属的轮次/调用组。

`ConversationTrajectory` 用两个集合（`collapsedTurns`、`collapsedCalls`）驱动投影：

- 工具栏提供“收起轮次 / 展开轮次”和“收起调用 / 展开调用”两个整体开关；没有可折叠项时按钮禁用。
- 摘要行是 44px 的普通行（虚拟化仍成立），显示“第 N 轮 · X 条记录 · Y 次调用”或“X 次工具调用”，点击即展开。
- 选中某条被折叠的记录（通常来自时间带）时，`unfoldTarget` 找到它所属的轮次/调用组并自动展开，随后滚动定位——深链和时间带定位不会因为折叠而失效。
- 折叠只作用于显示列表，`records` / Session 日志导出保持完整。

实机核验：11 条记录的多轮会话，“收起调用”把 3 个工具行收敛为“1 次工具调用”摘要；“收起轮次”把两轮收敛为“第 1 轮 · 7 条记录 · 3 次调用”等摘要；此时点击时间带的 `run_skill_script` 会自动展开第 1 轮并选中该记录、打开检查器。

## 运行记录

“运行记录”页只是项目级会话摘要列表，与轨迹重复；本轮从侧边导航移除。`/runs` 现在重定向到 `/chat`；旧的 `/runs/:id` 深链仍解析到所属会话的轨迹，回归测试继续覆盖。相关服务和 `ConversationRunSummary` 接口保留，未删除后端能力。

## 对话页面（chat）

现状：assistant-ui 流式聊天，已复用官方 ComposerTriggerPopover、ToolFallback、GroupedParts/ToolGroup、Reasoning；消息只有头像、正文和“查看本轮轨迹”。对照 DSH 后差距集中在“一轮的阅读结构”“消息级操作”和“可用的实时状态”。

| # | 优化 | 现状问题 | DSH 参照 | 工作量/价值 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| C1 | 一轮的过程与回答分区 | 推理、工具、正文平铺，工具多时整段被淹没 | `ui-chat/.../TurnProcessNodeView.tsx`、`conversation-nodes/turn-process.ts`：合成“过程折叠行”，折叠后保留回答，成员用 `hidden="until-found"`；回答前间距收到 8px | L / 高 | 纯前端 |
| C2 | 统一 24px 折叠行原语 | reasoning/工具/上下文各写一套折叠 | `ui-primitives/.../DisclosureRow.tsx`：16px 图标位 + 6px 间距 + 13/24 标题，悬停图标切换、整行可点 | S / 高 | 纯前端 |
| C3 | 消息操作行 | 只有“查看本轮轨迹”，无法复制；操作行没有 hover 显隐 | `ui-chat/.../MessageIconActions.tsx`：复制/分支/用量一排，非最新轮用 opacity 隐显，复制 1s 变对勾 | S / 高 | 部分需服务端分支语义 |
| C4 | 工具一行摘要 | 工具结果仍偏“JSON 展开”，缺少按工具类型的一行摘要 | `ui-tool/.../components/ToolRow.tsx`、`models/tool-call-model.ts`：运行/成功/失败/停止状态、参数派生摘要、路径、+增 -删 | M / 高 | 纯前端 |
| C5 | 用量与计时 | 无 token、无 TTFT、无吞吐 | `TurnUsagePanel.tsx`、`StatsPills.tsx`、`token-format.ts`：按请求与累计、cache 命中、TTFT/TPS，数字用 tabular-nums | M / 高 | **需后端**：`toAISdkStream` 未传 usage |
| C6 | 上下文占用表 | 输入框旁没有上下文余量 | `ui-conversation/.../ContextMeter.tsx`：环形 + system/tools/messages 分段 | S / 中 | **需后端** usage |
| C7 | 附件 | 无文件/图片输入 | `InputBar.tsx` 附件位、`ui-attachment`：选择、拖放、上传门禁、移除 | L / 中 | **需后端** 存储与权限适配 |
| C8 | 运行中的统一状态 | 只在错误时出提示，运行中缺少轻量状态 | `ChatView` 的 `.turnStatus`：一轮一条 shimmer，15s 后才出计时；`prefers-reduced-motion` 回退 | S / 中 | 纯前端 |
| C9 | 轮次导航轨 | 长会话只能滚动 | `ui-chat/.../TurnNavigator.tsx`：10px 间距刻度、悬停预览、点击跳转 | M / 中 | 纯前端 |
| C10 | 推理行 | reasoning 已有组件但折叠摘要跟随流式尾部 | `ReasoningRow.tsx`：运行中摘要右对齐取末行，正文 20px 行高缩进 22px | S / 中 | 纯前端 |

本轮已实现 C3 的复制部分与“回到底部”，其余未动。

## 轨迹页面（runs）

现状：三条分类轨道的概览 + 紧凑记录列表 + AntD Splitter 右侧检查器；支持分类筛选、搜索、全局收起、分页与完整性标记。DSH 的完整能力远大于此，但可数据支持的纯前端项已经不少。

| # | 优化 | 现状问题 | DSH 参照 | 工作量/价值 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| T1 | 概览改绝对定位时间带（已做） | 旧实现按 `repeat(records.length, 1fr)` 生成 3N 条网格轨道，且轨道只会按序号等宽 | `ui-trajectory/.../timeline.ts` `deriveTrajectoryTimeline` + `TrajectoryTimeline.module.css` `.span`：`position:absolute; left/width %; min-width:2px` | S / 高 | 纯前端 |
| T2 | 时长轴与空闲压缩（已做接收时长版） | 序号轴看不出慢调用 | `deriveTimedTimeline`：`duration`（压缩空闲）/`time`（完整墙钟）/等宽四模式 | M / 高 | 纯前端（当前只有接收跨度） |
| T3 | 拖选区间并压暗区间外 | 只能单选定位 | `TrajectoryTimeline.tsx` 指针状态机（`MINIMUM_DRAG_PX=3`、`centeredRange`）+ `trajectoryTimelineFocusIndexes` | M / 高 | 纯前端 |
| T4 | 时间带缩放与平移 | 长会话无法聚焦 | 滚轮 `nextDuration = clamp(domain*exp(deltaY*0.0015))`、右键平移、边缘自动平移 | M / 中 | 纯前端 |
| T5 | 记录列表虚拟化（已做） | `visible.map` 全量渲染，长会话卡顿 | `trajectory-virtual-rows.ts` + `@tanstack/react-virtual`：30px 行、overscan 12、`anchorTo:'end'`；本仓库先用等行高手写窗口，超 100 条才启用 | M / 高 | 纯前端 |
| T6 | 轮次/调用两级折叠（已做） | 只有全局“收起轮次” | `collapseTurnRecords` / `collapseAssistantRecords`：合成摘要行“N 步 · M 次调用” | M / 高 | 纯前端 |
| T7 | 工具调用与结果两栏合并 | 当前已合并为一条记录，但预览是单行文本流 | `.resultPreview` 两栏 + 箭头 + 失败配色 | S / 高 | 纯前端 |
| T8 | 请求边界标记与全局序号 | 无 | `indexRequestBoundaries`：16px 圆点、`top:-8px`、重试堆叠偏移 | S/M / 中 | 纯前端 |
| T9 | 检查器按类型给 tab 并记住上次 tab | tab 固定集合，切换记录总回到第一个 | `detailTabs` + `tabHistory` 最近使用；system 提示词 diff | M / 中 | 纯前端 |
| T10 | 分页向前插入时保持滚动位置（已做） | “加载更早轮次”会跳 | `olderLoadAnchor`：`scrollTop += newScrollHeight - oldScrollHeight` | M / 中 | 纯前端 |
| T11 | 每请求 LLM 耗时与 TTFT | 只有接收跨度 | `RequestUsagePanel`、`AssistantTimingPanel`：`preparedAt`→首个 `text-delta` 可做 TTFT 近似 | M / 中 | 纯前端近似；精确值**需后端** |
| T12 | token 用量与吞吐 | 无 | `addUsage`/`settleMessage`、`UsageRows` | L / 高 | **需后端**：`messageMetadata` 或 `data-usage` |
| T13 | reasoning 展示 | `sendReasoning:false` 被丢弃 | 折叠 thinking 区 | M / 高 | **需后端**：打开 `sendReasoning` |

约束：接收跨度来自控制面事件时间戳，不等于模型推理耗时；长度类界面必须标注来源。token、精确 TTFT/吞吐、reasoning 在运行时补齐前不应填样例值。

## 仓库层面的其他问题

- **CSS 可维护性**：`base.css`、`chat/styles.css` 等大量“一个 `@media` 块只放一条规则”。功能无碍，但难以整体调整断点，建议按断点合并（纯格式化，需回归视觉）。
- **单文件体积**：`Chat.tsx`（266 行）、`ConversationTrajectory.tsx` 已接近职责上限，可把消息渲染、操作行、时间带拆成子模块；注意 feature 只能用 `index.ts` 作为公开入口（`.dependency-cruiser.cjs`）。
- **构建体积**：`pnpm build` 一直提示大 chunk；`vite.config.ts` 已按 chat/antd 手工分组，可再核对 FlowGram/editor 是否只在工作流页懒加载。
- **无障碍**：轨迹的拖选、虚拟化落地后需保留键盘可达与 `aria-pressed`；新时间带已有 `aria-label`，拖选实现要与之一致。

## 建议顺序

1. ~~T5 + T10 + T6~~（已完成）：长会话可用性与两级折叠均已落地。折叠是显示层投影，不修改持久记录；被折叠的记录仍可通过时间带选中并自动展开定位。
2. T7 + T2 的时长/空闲压缩 + T3 区间选择：把概览变成真正的导航工具。
3. C2 + C8 + C10 + C3 的完整操作行：统一“折叠行”视觉，补齐运行状态与消息操作。
4. C4/C5 + T12/T13：需要先排运行时采集（usage、reasoning），再接入用量与计时。
5. C1 轮次过程折叠：依赖上面的行原语稳定后再做，避免返工。
