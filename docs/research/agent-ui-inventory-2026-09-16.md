# Agent UI 设计资产盘点（重写蓝图）

> 目的：把控制台中最有沉淀价值的 UI/UX 设计提炼成一份可独立阅读的规格说明。若未来重写新项目，本文档 + 少量模式代码即可重建当前对话与轨迹体验，无需依赖本仓库代码。
> 基准：commit `08cf979`，行号锚点以该版本为准。
> 范围：对话区（features/chat）、轨迹区（features/runs）、共享层（shared/）、应用骨架（app/）、平台助手（features/assistant）、Agent 编辑器（features/agents）。工作流画布与知识库等资源页未纳入本盘点。

---

## 0. 设计原则（贯穿全部界面）

这些是本项目最有辨识度的产品决策，重写时应作为第一约束：

1. **诚实性优先**：数据缺口显式列出而非隐藏（轨迹的 coverage 缺口清单）；null 永不显示为 0（Token"未报告"）；每条轨迹记录带 `source` 数据来源声明；计时来源五级标注（"首字节 ≠ 首 Token"）；计划完成标记 ≠ 验收通过。宁可文案变长，不伪造确定性。
2. **悬停永不引起布局抖动**：所有 hover 出现的控件要么绝对定位悬浮（用户消息操作条、复制按钮、提问标记栏），要么预留固定槽位（AI 消息操作栏 32px、过程行固定 28px 高）。
3. **渐进渲染**：长任务先上屏已加载部分（轨迹 250ms 节流进度回调 + 部分快照），加载进度用 2px 细线表达而非横幅；骨架屏（气泡形）替代文字 spinner。
4. **服务端是事实源**：客户端从不提交改写后的转录——编辑、清空、压缩全部是服务端原子操作（派生分支 / reset / compact），requestId 幂等防重放。
5. **轮次换代用 key**：`key={feedbackRun}`（反馈条）、`key={run/file/hash}`（产物预览）、`key={conversationId}`（会话），杜绝跨 run / 跨会话状态泄漏。
6. **可达性内建**：`aria-pressed/aria-expanded/aria-label` 全覆盖、`:focus-visible` 统一 2px 描边、tabular-nums 数字列、reduced-motion 降级、焦点还原（弹层关闭还给触发按钮）。

---

## 1. 全局信息架构

### 1.1 路由与骨架

- 路由表（`app/routes.tsx:8-32`）：`/login`、`/join`、`/team`、`/projects/:projectId/{page}`，7 个详情页带可选 `/:resourceId?`（agents/chat/workflows/knowledge/skills/mcp/runs）。
- 骨架（`app/ProjectConsole.tsx`）：固定侧栏 232px + 工作区；**顶栏承载页名**（紧凑页头：页名 `<h1.topbar-page>` 并入顶栏，左侧 1px 分隔线，无独立 heading 区块，`ProjectConsole.tsx:256-258`、`base.css:762-770`）；页面级主操作按钮（创建 Agent 等）也在顶栏，带 `data-agent-target` 供助手定位。
- 权限门控三层：侧栏导航过滤（无权页不显示，`ProjectConsole.tsx:100-113`）→ 页面级 Alert（`routing/ProjectPage.tsx:56-63`）→ 功能级按钮禁用/文案降级。权限数据 15s 轮询。映射表在 `shared/access.ts:20-27`（settings→project.manage，chat→agent.run 等）。
- 离开守卫（`routing/NavigationGuard.tsx:28-53`）：单一守卫覆盖链接/切项目/编程导航/POP；busy→阻止，dirty→confirm"离开未保存的草稿？"。
- 项目切换：顶栏 Select；`ProjectData`/`PageActionsProvider` 以 projectId 为 key 强制重挂、缓存清零。
- 移动端：侧栏进左抽屉；断点 1650/1150/900/760/600（`base.css:533-670`）。

### 1.2 设计 token

- antd theme（`app/main.tsx:29-45`）：主色 #246b59（墨绿）、正文 #263b36、圆角 8、控件高 38、Table headerBg #f8faf9、Select 选中底 #eaf2ee。
- assistant-ui `@theme`（`shared/assistant-ui/styles.css:15-31`）：全套浅色变量映射到平台色；**无暗色模式**。
- base.css 仅 4 个 CSS 变量（--accent/--text-secondary/--text-quiet/--text-quiet-dark，`base.css:9-12`）；其余是"antd token + 语义 class + 字面 hex"。字号刻度 11/12/13/14/16/18/22px（界面偏小字号）。
- 字体栈：Inter / -apple-system / PingFang SC；正文 ≥4.5:1 对比度。

### 1.3 数据层约定

- 每项目一个 QueryClient（`shared/data/ProjectData.tsx:99-115`）：staleTime 30s、gcTime 5min、retry false；卸载 cancelQueries 后 clear。
- 轮询模式 `useProjectQuery(resource, {poll})` 默认 5s；`useProjectRefresh` 按资源失效。
- 游标分页：`useProjectPages` + 响应头 `X-Next-Cursor`；手动"加载更多"（`PageMore`：已加载 N 条 · 已全部加载 / 重试），非无限滚动。
- 查询状态壳 `QueryState`（`shared/data/QueryState.tsx:11-50`）：出错但有旧数据→warning"当前显示上次成功加载的数据"+重试；无数据→error；加载→Spin。
- API 错误文案归一（`shared/api.ts:15-33`）：无 response→"无法连接平台服务"；404 特指"后端可能还没更新到当前代码"；5xx 指向服务日志。
- 本地存储：sessionStorage 统一前缀 `platform-chat:v1:`，存储被禁用不阻断功能（`shared/data/session-storage.ts`）；作用域 `${tenantId}:${userId}:${projectId}`。

---

## 2. 对话界面设计

### 2.1 工作区布局与会话列表（ChatWorkspace.tsx）

- **三段式**：`section.chat-workspace` = 左 `<aside class="conversation-list">` + 右 `.chat-main`；页面容器 `height: calc(100dvh - 76px)` 锁视口。
- **列表显隐**：`showList = !selectedId || listOpen`——未选会话强制显示列表；选中后默认隐藏靠按钮展开。折叠按钮 `aria-expanded/aria-controls` 关联。
- **顶栏**：折叠按钮 +（折叠时）新建 → 标题（h1 + 重命名 + 发布版本 Tag"此会话使用创建时的 Agent 发布版本"，v0 显示"草稿试用"）→「对话/轨迹」Tabs（`view=trace` 查询参数驱动）。
- **新建会话 = Agent 先行**：Modal 列出有 `publishedReleaseId` 的 Agent，点击即创建会话；无已发布 Agent 时引导跳转。
- **自动选中"最后查看"**：选中即写 sessionStorage（`${scope}:${projectId}:viewed:last-conversation`）；进入 /chat 无 id 时恢复，失效则回退列表第一条。**绝不显示空白面板；重复点击"对话"不切换会话**（`ChatWorkspace.tsx:106-123`）。
- **列表分组**：置顶（独立查询 `pinned:"true", limit:50`）+ 时间分组（今天/昨天/近 7 天/更早，本地日期计算）；搜索时折叠为单一"搜索结果"组（纯前端 title 过滤）。
- **列表项**：pin 图标 + 标题单行省略 + "v{N} · MM/DD HH:mm"；行内操作（置顶/重命名/删除）`opacity:0` 悬停显示。删除带 Popconfirm"会话、消息和运行记录将一并删除"+ 手动清缓存与草稿。
- **重命名双入口**：列表项内联 input 与头部标题，同一套键盘约定（Enter 提交 / Escape 取消 / blur 提交）+ 防双提交 ref。
- **滚动隔离**：桌面端仅 `.conversation-list-body { overflow-y: auto }` 滚动，头+搜索框 flex-shrink:0；≤600px 列表变横向条带。
- **历史装载**：`getConversationSession` 一次（gcTime 0, staleTime Infinity），此后活跃 Chat 接管；加载态用气泡骨架屏（交替 user/assistant 渐变动画）。
- **空状态**：欢迎语 + "伪输入框"按钮（外观仿 composer，点击打开 Agent 选择 Modal）。

### 2.2 输入框（ChatComposer.tsx）

- **上下文占用环形按钮**：18×18 SVG 双圆环，`strokeDasharray = ratio × 2πr` 从顶部起画；warn 阈值 **75% 与自动压缩触发点一致**（黄），≥100% 红。
- **悬停明细浮层**（Popover）："上下文已用 N%" + `~12K / 128K`（≥1万取整 K）+ 4px 进度条 + 分类明细（系统提示词/工具定义/对话消息，各带彩色圆点）+ 底部提示"达到窗口 75% 时，下次运行自动压缩历史；/compact 可立即压缩"。数据来自 `getConversationContext`（staleTime 10s，**run 落定瞬间 refetch**）。
- **Skills 选择**："本次使用"标签行（closable，停用变红）+ 警示"所选 Skill 已停用…请移除后发送"；语义是**只影响下一条消息，发送成功自动清空**；上限 10 个。
- **斜杠命令**（`commands.ts`）：系统命令（/clear /new /compact [重点] /context /help /stop /skills）+ Skill 动态命令（同名冲突挂 `/skill ` 前缀）。触发匹配器：**fenced code block 内不触发**、行首/标点后的 `/` 才算。运行中过滤破坏性命令。`removeOnExecute`（发送后从输入框移除）。
- **发送/停止**：同位置按钮切换（ArrowUp 圆形绿钮 ↔ 停止）；取消中 aria"正在停止"且 disabled。
- **输入体验**：rows=1 自增高（max 192px）、`enterKeyHint="send"`、↑/↓ 召回历史发送记录、Shift+Enter 换行提示（窄屏隐藏）、Web Speech 听写（按 adapter 存在性门控）。
- 禁发条件：断连/恢复中/所选 Skill 不可用。

### 2.3 消息渲染

- **AI 轮次容器**（ChatTurn.tsx）：
  - **过程摘要按钮**（固定 28px 高行）：outcome 文案机——服务端保存态优先（失败→"执行失败"、cancelled→"已停止"）> 工具失败计数 > 运行中（"正在{当前工具}"）> incomplete > "处理完成"；副标题"X 段思考 · Y 次工具"；右侧"展开过程/收起过程"。运行中默认展开，**流结束瞬间不自动收起用户正在看的过程**。
  - **中断横幅**：failed/cancelled 时左橙线提示"此轮已停止/执行失败 · {错误码中文名}。以下为已记录的部分内容，完整过程可在轨迹中查看。"
  - **本轮工作区**（RunWorkspace 轮询：运行中 1.5s，落定 Infinity）：补充要求列表（标注执行器已读/未读）、执行预算条（模型请求 3/20 · Token 12k/100k · 恢复 1 次）、工作进度（objective/progress/nextSteps）、Skill 加载列表、子任务列表（`<details>` 每项"状态 · 工具 2/5" + "查看子任务完整轨迹 ↗"深链）。
  - **产物卡片区**：`data.artifacts` 渲染 ArtifactCard 网格（auto-fit minmax 240px）。
- **用户消息**（thread.aui.tsx:381-436）：右对齐气泡；操作栏**绝对定位悬浮在气泡下方**；只有最后一条用户消息可编辑（tooltip"编辑并派生新分支"）；footer 显示"本次指定"的 Skill Tags。
- **AI 消息操作**：复制 + 导出 Markdown + 朗读（Web Speech）+ **派生分支按钮**（`deriveConversation({upToMessageId, requestId})`，"已派生新分支，原会话保留"）+ 耗时标签（只用浏览器观测耗时，不用 token 估算）。
- **思考折叠**（reasoning.tsx）：流式时强制展开 + **钉底滚动**（向上滚动=用户意图才取消 pin）；流式预览取最新一行（跟随思路），结束后取首行；240 字预览去 markdown 标记。
- **流式光标**：`animate-pulse` 的 "●" + `role="status"` aria"正在生成回复"。
- **长列表**：`content-visibility:auto + contain-intrinsic-size` 懒渲染；`turnAnchor="top"` 新轮次视口锚顶。

### 2.4 提问标记栏（ChatTurnRail.tsx，ZCode 风格）

- 右侧 6px 处垂直短横线（12px，hover/active 变 22px 加深）。
- **实现要点**：绝对定位 host 覆盖 viewport（sticky 在内容末尾永不重新进入可视区）+ ResizeObserver 同步高度 + `pointer-events:none` 仅按钮可点。
- **标记读取**：从已渲染 DOM 查 `[data-role="user"]`（活跃消息与恢复的历史行为一致），preview 取前 80 字符；MutationObserver(childList+subtree+characterData) 监听重读。
- **active 高亮**：滚动时以 `scrollTop + clientHeight × 0.3` 为视线；hover 气泡"第 N 条提问"+预览；点击 smooth scroll；**只有 1 条提问时不渲染**。

### 2.5 工具卡片

- **通用骨架**（ChatToolCards.tsx）：图标+中文 label+单行 summary+outcome+chevron 的固定高度行；右侧"轨迹 ↗"深链（`recordId={runId}/tool:{toolCallId}`）；状态标签（进行中/已取消/执行失败/等待确认）；`run_skill_script` 的 `exitCode !== 0` 视为失败即使 SDK 没标；尾部"调用参数"details。
- **内容渲染三级**（ChatToolContent.tsx + shared/ai/ToolResult.tsx）：特判卡 > 按工具名定制 > 结构化通用。
  - **结构化三态**：纯标量行数组→antd Table（列并集、20 条/页）；"标量字段+行数组"信封→dl 事实列表+分节表格；其他→JSON pre。
  - 截图：base64 校验（≤7MB + PNG magic 头）通过才内嵌，失败提示从产物下载。
  - 脚本：退出码 header + Tabs「结果/输出/完整记录」，stdout 可 JSON.parse 时结构化渲染，失败默认落"输出"tab。
  - Skill 文档：markdown 给「阅读/原文」Tabs。
  - 每个原始内容右上角绝对定位复制按钮。
- **计划卡**：`readPlan` 严格校验（revision 1-100、items≤20、状态枚举）失败回落通用卡；标题"v{N} · {completed}/{total} 完成{ · M 受阻}"。
- **子代理卡**：双数据源（工具 result + RunWorkspace live 按 parentToolCallId 合并）；live 补充实时工具计数/activity。
- **知识引用卡**：`knowledge_search` →"知识检索 · N 个来源"，每个 `<details>` 显示文件名·位置·版本，可"定位原文"打开 DocumentReader。

### 2.6 过程摘要（process-summary.ts + ProcessIcon.tsx）

- 40+ 工具中文名映射（browser_goto→"打开网页"、workspace_publish→"保存产物"…）。
- summary 取 args 第一个有值字段（operation/entrypoint/command/url/path/query…），fallback 取前两个标量 arg `key: value`；`sum_values` 渲染为算式 `1 + 2 + … → total`。
- 图标按工具名前缀/关键词稳定映射（与执行状态无关）。

### 2.7 编辑 = 服务端派生分支（ChatEdit.tsx）

- 客户端从不提交改写后的转录；`editConversationMessage({messageId, input, requestId})` 服务端原子派生，拿到 branch.id 切换。
- requestId 幂等（同文本复用同 requestId 防重复派生）。
- 编辑器占消息本体位置；Ctrl/Cmd+Enter 发送（检查 `isComposing` 防中文输入法误触）；底栏固定说明"修改将派生为新分支，原会话完整保留"。

### 2.8 运行中反馈（ChatFeedback.tsx）

- **与草稿完全分离**（注释："提交反馈绝不能启动第二次 run"）：独立 textarea ≤2000 字 + 显式保存按钮。
- 成功提示明确时序："要求已保存，执行器将在下一次模型请求前读取；最终回复已经生成时，请在下一轮继续"。
- 提交后出现在轮次工作区"本轮补充要求"列表并标注已读状态。

### 2.9 断线/刷新恢复（ChatRecovery.tsx + continuity.ts）

- **三合一恢复**：打开装载历史 + 刷新发现进行中 run（`resumeRun`）+ 断线重连，全部走同一个 `getConversationSession`。
- **双通道恢复策略**：streamId 匹配→直接 `resumeStream()`；新发现的 run→只写 storage 让 runtime 自愈（**避免双读者**——GET 头未到时 resumeStream 会开两条流）。
- 自动重试 2 次（1s/3s 退避）+ `window online` 事件；恢复用服务端最新消息 `setMessages`（**服务端历史消解 POST 不确定的歧义，不会双发乐观消息**）。
- **取消必须打服务端 API**（流断开 ≠ 运行终止）；runId 未到达时 pendingCancel 兜底。

### 2.10 产物预览（ArtifactCanvas/Card/Preview）

- **画布归属会话而非消息**（key=projectId/conversationId）；文件条目留在转录中（卡片：图标+名称+来源+KB），**所有查看集中在画布**——不改变轮次高度。
- 双形态：宽容器（≥900px，ResizeObserver）→ Splitter 并排（对话 44%/产物 56%，双击 dragger 复位）；窄容器→右侧全高 Drawer。
- **HTML 沙箱**：`sandbox="allow-scripts"` + srcDoc **前置 CSP meta**（default-src 'none'，仅 inline、data:/blob: 图片）；「预览/源码」+「桌面/手机 390px」切换。
- 文本拉取 2MB 上限（超限引导下载）；**视图 key = run/file/hash——文件切换不可能显示上一个文件的响应**；Escape 关闭并焦点还原触发按钮。
- 卡片选中描边高亮；独立下载 `<a download>`，title 显示 SHA-256。

### 2.11 草稿持久化

- 只存**未发送草稿**（text+skills）到 QueryClient（gcTime Infinity）+ sessionStorage 双写，composer.subscribe 同步。
- 按账号+项目+会话+标签页隔离；读取带形状校验（text≤16000、skills≤10）不过即弃。
- 外部预填（平台助手）按 `prefill.id` 幂等，与现有文本换行拼接。

### 2.12 压缩 UX 三件套

1. **进行中 Alert**：`data-context-compaction` part → "正在压缩上下文 · 第 X / Y 部分"，说明"摘要完成后用于后续对话，原始记录和轨迹继续保留"。
2. **/context 面板**：`原始消息 N 条 · 摘要覆盖 M 条` + 最近压缩时间或"接近窗口阈值时会自动压缩" + `<pre>` 摘要全文 + "首条原始目标仍单独保留"。
3. **/compact [重点]**：本地置进度态 → 发送字面 `/compact ...` 由服务端执行，进度经 data part 回流。

### 2.13 错误处理

- 错误码→人话映射表（`run-status.ts`：TOKEN_BUDGET→"下一次请求将超出 Token 预算"等 10 个）；取消不算错误（abort 不报）。
- 非断连错误显示可关闭 Alert；断连交给恢复条（"正在恢复对话…"/"连接已中断，后台任务仍可能在执行。"+重连按钮）。

---

## 3. 轨迹界面设计

### 3.1 信息架构

- 入口：聊天页 `view=trace` 查询参数；`runId`/`recordId` 深链参数。**没有独立运行列表页**——`/runs/:id` 重定向到所属会话轨迹。
- 分层：`ConversationTrace`（数据编排）→ `ConversationTrajectory`（工具栏+时间轴+虚拟列表）→ `TrajectoryInspector`（Tab 详情）→ `TrajectoryDetails`（概览卡/值树）。
- 组件以 `key={projectId}/${conversationId}` 强制重建，会话切换零残留。

### 3.2 数据模型（trajectory.ts，1098 行，核心资产）

- **统一展示行 `TraceRecord`**：9 种 kind（system/user/context/model/tool/agent/plan/error/run）× 5 种状态（running/succeeded/failed/interrupted/**unloaded**——纯前端态：轮次有未加载事件且运行已终态）。"分页永不改变语义 record ID"。
- **单轮投影 `projectTrajectory`（events → records）**：
  - 系统记录：从 `data-model-request` 的 messages 提取 system/developer，source 如实标注来源（"Runtime 实际模型请求" vs "发布版本快照；此历史运行未记录完整模型请求"）。
  - **合并键**：tool 类全部合并到 `tool:{toolCallId}`；text/reasoning 系合并到 `model|reasoning:{step}:{chunk.id}`（provider 内容块 id 为键——网络重试的新 id 天然分块）；error 每条独立。
  - **字段累积**：`text-delta → text +=`、`reasoning-delta → reasoning +=`、`tool-input-delta → text +=`；start/end/available 覆盖 input/output 与终态。
  - **观测回填**（第二轮）：`data-model-response`（ModelRequestTiming）按 requestIndex 找请求记录附加计时；`data-tool-execution` 按 toolCallId 附加工具计时。
  - **计划**（第三轮）：`data-task-plan` 把对应工具记录改为 plan kind，source 注明"事项状态由 Agent 报告，不等于独立验收或用户批准"。
- **会话级投影 `projectConversation`**：
  - **重试归属规则**：同一 step 多个请求（传输重试）中，只有最后一个非 failed/interrupted 的尝试（owner）拥有该语义 step 的输出；"传输序号 ≠ 模型 step 序号"。非 owner 的内容块降级为 owner 的 `segment` 子行（"保留独立内容、顺序与事件时间"）。
  - **采集完整性 coverage**：逐项检查并生成中文缺口清单（"实际模型请求未采集/计时未采集/用量未采集/供应方未报告 Token/历史推理未记录"）。
  - **已保存回复兜底**：流式正文缺失但 `run.outputText` 存在→插"已保存的回复"记录，source"流式正文未记录，无法还原中间过程"——**已存消息是独立事实源，绝不伪造 delta**。
  - **子代理挂接**：`data-subagent` 生命周期按 state.id 聚合 + `data-subagent-event` 解包（委托只有一层深）→ 合成 childRun **递归投影**完整子轨迹；子记录 id 加 `child/` 前缀；找不到 parentToolCallId 对应工具时在最近请求后插入合成记录。
  - **id 命名空间**：`${runId}/` 前缀防"provider 复用 id 或并行到达时跨子代理边界"。
- **两级折叠**：轮折叠（摘要行"第 N 轮 · X 条记录 · Y 次调用"）+ 调用组折叠（owner 归属："只有紧跟同一 turn+scope 的 model 记录之后的调用才成组"）；`unfoldTarget` 沿 parentId 链返回解锁所需全部折叠键——**深链/搜索/手动折叠三者不打架的实现**。
- **时间轴投影**：sequence（等宽槽）/ duration（按控制面接收时间跨度，"不是模型推理时长"）双模式；每泳道最多 3 轨贪心分配；点观测给最小视觉宽度而不伪造时长。

### 3.3 读取协议与性能策略（单轮 2 万+ 事件 → ~7 秒）

**服务端 delta 合并**（读取侧，`control-plane/.../compact.ts`）：
- 只合并 3 种类型：`text-delta`（键 chunk.id）、`reasoning-delta`（键 chunk.id）、`tool-input-delta`（键 toolCallId）。
- flush 条件：类型变化/键变化/累计 20000 字符/遇不可合并事件/流结束。
- **合并产物身份：保留首事件其余字段，seq 取该组最后一个**——"投影输出不变，游标分页既不漏也不重文本"。这是整个方案可缩放的核心。

**读取策略**：
1. 每轮内联仅 500 条（`LIMIT 501` 探测 hasMoreEvents）+ `checkpoint {eventCount, lastSeq}` 完整性契约（合并后事件数小于原始计数也成立）。
2. 轮次分页（`before` 游标每页 10-20 轮），深链自动逐页回溯。
3. **尾部续读**：`GET /runs/:id/events?after&through&compact=deltas`；"不前进即报错"双重检测（事件分页与轮次分页各一）；进度 250ms 节流发布渐进上屏。
4. **并发读取器**（trace-reader.ts）：并发 3 + 优先级队列（新轮/聚焦轮优先，聚焦轮 `MAX_SAFE_INTEGER`）+ 微任务批量入队（等本次 render 所有任务入队再挑选）+ abort 级联 + checkpoint 种子缓存。
5. **投影与获取解耦**：纯函数投影 + **WeakMap 按轮缓存**（读一个尾部绝不重投影旧轮）+ mergedCache 引用相等记忆化 + tailsKey 字符串签名。
6. **轮询仅限 running/queued（3s）**；checkpoint+run JSON 未变则跳过赋值；查询 `gcTime:0, structuralSharing:false`。retained ref 修复"较旧的运行中轮落在最新一页之外"的盲区。

**渲染策略**：
7. 行数 >100 才虚拟化（**固定 56px 行高使窗口数学精确**，overscan 12）；上翻锚定（prepend 后按 `scrollTop + (newH - oldH)` 恢复阅读位置）。
8. 搜索索引每投影构建一次（全字段 JSON 化 join 小写）；**搜索模式绕过折叠**（命中记录+父链+所属轮头）。
9. 时间轴 4px 桶聚类（聚类显示观测而非协议事件，缩放后恢复单个目标）。
10. 详情懒展开：原生 `<details>` + 每层 50 条分页（"分支按需挂载，让大型工具结果检查保持廉价"）。

### 3.4 概览时间轴（TrajectoryTimeline + timeline-window.ts）

- 时间窗：域固定 0-100（归一化百分比），宽度钳 0.05-100；锚点缩放（滚轮以光标为锚，`exp(deltaY×0.004)` 钳 ±0.7）；Shift+滚轮平移。
- **三通道操作**：滚轮缩放 / 指针框选（4px 移动阈值 + setPointerCapture，松手选区内最左 span 自动选中）/ 键盘（+/− 缩放、←/→ 平移、Home 复位、Esc 取消框选）。
- 聚类 mark 点击→以聚类范围+15% padding 放大并选中；选区外 mark 降透明度；聚合 mark 白条纹纹理+计数。
- 序号/耗时双模式切换（mode 切换重置窗口状态）；标尺显示窗口百分比。

### 3.5 检查器（TrajectoryInspector，581 行）

- 头部：标题 + "第 N 轮/会话初始配置" + 上一条/下一条 + provenance 行（kind Tag + **每条记录的 source 数据来源声明**）。
- 动作区："定位模型请求/返回子代理"跳转；"复制记录"（结构化 JSON：events 替换为 seq 列表）。
- **动态 Tabs 装配**：
  - **概览**（2×2 指标卡：请求耗时/首内容延迟/输入输出 Token；facts 行；调用生命周期四相列表，未记录相灰点标记；"执行明细"子记录列表）。
  - **内容**：model→markdown（skipHtml、图片降级 alt）；tool→ToolResult；run→coverage 缺口清单 + 已保存最终消息；空正文三分支文案（失败/仅有推理/未返回）。
  - **请求内容**：模型与参数 + **上下文对比**（与上次请求逐消息 canonical JSON 比较："前 N 条相同；其后 M 条为本次新增或变更"）+ 每条消息按 tool_call_id 反查原工具结果提供内链 + 末尾"完整请求 JSON（含工具定义）"details——**点开即见完整模型请求**。
  - **本轮运行**：状态/运行 ID/发布版本/Runtime/指定 Skills。
  - **工具 (N)**：toolsSource provenance + 每工具参数 schema；历史无 schema 明确"不能用当前定义替代"。
  - **用量**：Token 全 nullable（null 一律显"未报告"，**不按 0**）+ 子任务单独列示（"避免混淆或重复计算"）+ perStep details。
  - **计时**：开始/结束/耗时/计时来源（5 级中文说明："首字节不等于首 Token"/"含排队"等）；HTTP 状态/首字节/响应字节。
  - **记录信息**：记录 ID/运行 ID/消息 ID/调用 ID/事件序号列表/原始协议事件 (N) details——**每个事件的完整原文可查**。

### 3.6 导出与诊断

- "导出完整会话"：互斥锁 + 进度条；JSON 含 formatVersion/scope 说明（"连续增量已合并为单块；导出期间的新事件不包含"）/records(sessionLog)/protocol(原始 turns)。
- 开发者诊断折叠：可下载已加载协议数据（"协议数据用于排错，包含流式分片"）。
- 部分轮次加载失败：Alert + 逐个重试按钮。进度条是工具栏下 2px 细线（"错误保持显式，其余静默完成"）。

---

## 4. 平台助手与页面协作

### 4.1 助手侧栏（PlatformAssistant.tsx）

- **Splitter 布局**：业务页与助手同层（非 Modal）；右面板默认 420px（min 340/max 1000），宽度记忆 sessionStorage；⌘/Ctrl+Shift+K 全局开关；页面操作/切换不自动收起。
- 触发器：运行中 live dot + 协作中状态 chip + "停止页面操作"入口（只停页面协作不停对话）。
- 任务台：上下文条（当前页面 + "继承你的权限 · 按任务使用能力"）；未配置模型 onboarding；历史切换器（运行中禁用）；关闭后焦点回触发器。
- **变更清单**：proposals 2s 轮询；"有待审阅的更改"提示；应用/放弃后注入 prefill 让助手核对。
- **让位逻辑**：`AssistantDockContext` 让业务面板（Agent 草稿试用）感知助手占用——**试用与助手互斥**，点"显示试用"先关助手。

### 4.2 页面协作（ApplicationCollaboration + PageActions）

- **安全模型**：助手只见**显式注册的 handler**（`usePageActionTargets`），模型不能传任意选择器或 JS；`[data-agent-target]` 唯一匹配定位。
- 执行流水线：执行前+后各查一次 viewRevision 防竞态 → 步骤记录 applying→verifying→applied → 双 rAF 等 React commit → 4s 轮询页面 ready → **act 后校验字段值已呈现**。
- **草稿守护**：`assertDraftState` 序列化对比 targets——用户改了草稿立即中止剩余字段操作。
- **回执幂等**：requestId + canonicalJson 签名，冲突拒绝，上限 2000 条；同时只允许一个活动。
- **操作反馈**：目标元素固定定位高亮框（rect 逐帧测量并**钳制到所有可滚动祖先**——离屏字段不能高亮到工具栏）+ BorderBeam 光带；操作后紧凑摘要（每步 before→after diff + "定位"按钮滚动到目标）；`del/ins` 双色 diff。
- 第三方应用：独立 origin + iframe sandbox + 650ms 心跳 action 循环；"允许修改未保存草稿"权限 checkbox 连接后锁定；document 隐藏自动 stop。

---

## 5. Agent 编辑器（草稿-试用-发布工作台）

- 全页三栏：左导航 166px / 内容 / 右预览 340-37%；工具栏含状态行"有未保存的修改 / 草稿 rN · 已保存" + 发布 Tag。
- 五分区（用途与指令/知识与技能/工具/运行设置/发布记录），kicker"01 /"+ 问句式标题；校验失败自动跳对应分区。
- **草稿/发布模型**：保存带 `baseRevision` 乐观并发；发布前 Modal 展示"本次变更"（分区级 diff）+ "已有会话继续使用原版本"；发布记录含快照摘要与变化分组。
- **试用**：内嵌完整 ChatSession；sessionStorage 持久化（含 draftRevision 校验）；`previewStale` = dirty → 顶部警告"配置已变化，当前对话仍使用原草稿"；空态"保存并开始试用"+"试用会计入模型用量"。
- 运行设置三档预设卡（日常问答 5 步/持续迭代 30 步/复杂任务 80 步，完整 executionLimits）+ 三开关（计划/委派/网页工作区）。
- 起点三选卡（写 instructions 预填；research 同时预设 30 步+计划）。

---

## 6. 服务端 UI 契约（重写时必须对齐的协议）

### 6.1 对话与流

| 契约 | 说明 |
|---|---|
| `POST .../conversations/{id}/chat` | **body 只含最后一条用户消息 + skillVersionIds**；响应头 `x-platform-run-id` |
| `GET .../conversations/{id}/session` | `{messages, resumeRun}`——装载/刷新恢复/断线重连三合一事实源 |
| `GET .../conversations/{id}/stream?runId=` | SSE 续读 |
| `GET .../conversations/{id}/context` | `totalMessages/coveredMessages/summary/contextTokens/contextWindow/contextBreakdown{system,tools,messages}` |
| `resetConversation {requestId}` | /clear 服务端原子开新分支（fork） |
| `deriveConversation {upToMessageId, requestId}` | 派生分支（复制历史不重跑） |
| `editConversationMessage {messageId, input, requestId}` | 编辑 = 服务端派生 |
| `submitRunFeedback {text, requestId}` | 运行中补充要求 |
| `GET .../runs/{runId}/workspace` | 本轮 feedback/execution 预算/taskState/skills/artifacts/subagents |

### 6.2 轨迹

| 契约 | 说明 |
|---|---|
| `GET .../conversations/{id}/trajectory?before&limit(1-20)` | `{initial, turns, totalTurns, nextBefore}`；每轮内联 ≤500 条 + `checkpoint{eventCount, lastSeq}` |
| `TraceTurn` | `{number, run, events≤500, hasMoreEvents, checkpoint, messages}`（messages 按 metadata.runId 精确关联，**绝不按文本相似匹配**） |
| `RunEvent` | `{seq, chunk(原始协议), createdAt, occurredAt, timeSource, observation?}` |
| `GET .../runs/{id}/events?after&through&compact=deltas` | 尾部续读；`compact=deltas` 服务端合并 token 级 delta；**REPEATABLE READ 快照** |

**观测事件类型 → UI 呈现**：
- `data-model-request` → "运行上下文 · 请求 #N"记录 + 请求内容 Tab（完整模型请求可查）
- `data-model-response`（httpStatus/首字节/字节数/outcome）→ 计时 Tab + duration 泳道（"firstByteMs 是首响应字节不是首 token"）
- `data-tool-start/execution` → 工具行计时 + 四相生命周期
- `data-run-usage`（全 nullable TokenUsage + perStep 按流序位置对齐）→ 用量 Tab
- `data-model-step`（stepIndex，"传输重试共享其 stepIndex"）→ 请求行 generation 挂接
- `data-task-plan` → plan 记录 + 版本 diff
- `data-subagent` / `data-subagent-event` → 子代理作用域轨迹（递归投影）
- `data-context-compaction` → 压缩进度 Alert
- `data-run-capabilities` → coverage"历史推理是否产生"判断依据

---

## 7. 可移植性分级总表

### A. 换项目几乎零修改可用
- `shared/assistant-ui/` 全目录（上游 assistant-ui 固定提交 `3a45a01c` + 本地适配：slot 扩展、防抖动 32px 槽位、钉底思考折叠、审批 UI 保留）——只依赖 @assistant-ui/react、Radix、tailwind；换项目只改 `styles.css:15-31` 颜色映射。
- `useLifetime` / `useOperation` / `page-action-activity`（纯语言级）。
- `ToolResult` 三态结构化渲染、`QueryState` 旧数据保留、`pages.tsx`（PageMore/prependPage）、session-storage（换前缀）、`loginDestination` 防注入、`failureMessage` 错误文案归一模式。

### B. 模式可复用（代码需重接数据层）
- **对话区**：服务端持有历史+只发最后一条；三合一恢复+双通道续流；服务端原子派生（编辑/清空/压缩）+ requestId 幂等；占用环 75% 阈值与自动压缩对齐；反馈与草稿分离；提问标记栏（DOM 读取+MutationObserver+绝对定位）；斜杠命令协议（fenced code 不触发）；工具卡片三级渲染；产物画布（CSP 前置沙箱、key=run/file/hash）；会话列表全套（游标+时间分组+悬停操作+最后查看恢复+滚动隔离）。
- **轨迹区**：delta 合并（三类型/双键/20000 上限/seq 取尾）；checkpoint 游标协议+"不前进即报错"；优先级并发读取器；纯函数投影+WeakMap 轮缓存；两级折叠+unfoldTarget 祖先链；时间窗+桶聚类；手动窗口虚拟化+上翻锚定；诚实性文案体系（coverage/null≠0/source/provenance）。
- **骨架**：紧凑页头（页名并入顶栏）；三层权限门控；NavigationGuard；EditorForm 抽屉壳；ProjectData 每项目 QueryClient；草稿-试用-发布工作台模式。

### C. 绑定本项目（重写需换数据层）
- `@platform/sdk` 全部接口与响应头约定（`x-platform-run-id`/`X-Next-Cursor`）。
- assistant-ui runtime API（useChatRuntime/AssistantChatTransport/ResumableClientStorage/unstable_* hooks）——模式可移植，API 需重接。
- RunWorkspace 域模型（execution 预算/子代理生命周期/feedback 已读回执）、Skill 版本体系、发布版本语义、项目/租户作用域。
- 平台协作协议（@platform/agent-ui manifest/心跳/回执）。
- legacy 兼容逻辑（无 checkpoint 重读、无 stepIndex 顺序推断、/runs/:id 重定向）——**新项目从第一天采集完整可全部省略**。

---

## 8. 若重写：建议保留 vs 裁剪

**保留（这些设计被验证过且构成体验差异）**：
1. 轨迹"诚实性"体系——这是本项目最有辨识度的产品决策，别处很少见。
2. delta 合并 + checkpoint 协议——性能问题的正确解，重写时应从第一天内建（含观测事件采集）。
3. 服务端原子会话操作 + requestId 幂等——多端/恢复场景的地基。
4. 防抖动纪律（绝对定位/固定槽位）——一次性设计，事后修补极贵（本项目修了 3 轮）。
5. 占用环+压缩三件套、提问标记栏、产物画布——低成本低感知高。

**裁剪**：
1. legacy 轨迹兼容路径与 /runs/:id 重定向。
2. antd + Tailwind 双体系（assistant-ui 用 tailwind @theme，其余用 antd token + 语义 class）——重写时二选一。
3. 无暗色模式的样式写法——重写时直接上 token 化方案。
4. `ProjectData` 的 14 类资源 loader 表——按新领域模型重设。

---

*生成方式：三个并行代码盘点（对话区 67 次工具调用 / 轨迹区 28 次 / 共享层 72 次），全文逐文件阅读后汇总。*
