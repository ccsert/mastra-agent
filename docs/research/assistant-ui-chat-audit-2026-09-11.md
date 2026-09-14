# Chat 实现审查与 assistant-ui 复用方案

日期：2026-09-11。审查对象：HEAD `6a2ff15cc371974c771e7a8a0b4b88d587a38d60` 加当前未提交工作区。本文是实现审查与改造建议，未实施产品重构。

后续已开始实施；本文保留审查时的状态与行号，当前进展及验证见 [Chat 第一批优化记录](assistant-ui-chat-optimization-2026-09-12.md)。

## 结论

当前已经用了不少 assistant-ui，但主要复用了行为 primitives 和几个局部 Elements；核心 Thread、消息阅读布局、Markdown 外观、动作栏展示策略、会话列表和会话生命周期仍由平台逐块拼装。继续增加导出、语音、耗时等按钮，不能解决阅读与会话连续性问题。

建议以官方完整 Thread 源码作为 Chat 表面的基线，保留平台的 Agent/发布版本、Skill 选择、知识来源、运行轨迹及传输适配；随后统一会话 runtime 的生命周期。成功标准应是阅读和操作变好、草稿不丢、运行状态可恢复，而不是用了多少个组件。

## 核对方式与版本

- 在线阅读用户指定的 [文档入口](https://www.assistant-ui.com/docs/)、[llms.txt](https://www.assistant-ui.com/llms.txt)，以及本文各行链接的官方能力页。
- 当前安装：`@assistant-ui/react@0.15.18`、`@assistant-ui/ai-sdk@0.0.4`、`@assistant-ui/react-markdown@0.14.14`、AI SDK `7.0.93`。
- 读取安装包的 ActionBar、`useChatRuntime`、`useChatThread`、resumable transport 和 AI SDK fetch 实现。
- 重新下载并核对现有引入基线 [`3a45a01c0d6141102638ecd4f32d1af4d01fb510`](https://github.com/assistant-ui/assistant-ui/tree/3a45a01c0d6141102638ecd4f32d1af4d01fb510) 中的 `thread.aui.tsx`、`markdown-text.tsx`、`thread-list.aui.tsx`。不把网站最新 API 自动视为当前安装包能力。
- 在现有 Edge 登录会话中查看实际 Chat，并做 A → B → A 草稿切换验证；没有发送消息或调用模型。

## 已确认的问题

### 1. 阅读区域没有限制宽度，输入操作被拉散

宽屏实际页面中，正文和 Composer 横跨整个主内容区。用户消息和助手消息都从同一左侧位置开始，只有小头像和浅色身份文字区分；长回复呈现为后台记录列表，扫描问答边界费力。

代码依据：`features/chat/styles.css:145` 的内容区没有阅读宽度约束；`:184` 正文为 13px；`:207` 消息体 `flex: 1`；`:264` 输入工具栏用 `justify-content: space-between`，将四个子项平均拉开。截图中麦克风落在整条输入框中部，与快捷指令和发送按钮形成三个分散区域。

官方固定源码已把内容和 Composer 放在同一 `max-width` 容器中，默认 `--thread-max-width: 44rem`，并提供用户消息、助手消息、空态、加载态与操作栏的完整组合。应直接采用这一层，再按中文阅读调整主题与字号。平台头部保留必要身份，版本/会话 ID 等辅助信息降低视觉权重。[Thread](https://www.assistant-ui.com/elements/thread)

### 2. 会话切换确实丢失未发送草稿

实机步骤：在原本空白的输入框输入 `（界面检查草稿，未发送）` → 切到另一现有会话 → 返回原会话。输入框变空，发送按钮禁用。已返回原会话，没有新增消息。

代码依据：`ChatWorkspace.tsx:175` 以 `conversation.id` 为 key 重新挂载 `ConversationSession`；`Chat.tsx:295` 的 Skill 选择也是组件内状态。Composer 状态随整个 runtime 的生命周期消失。这不是样式问题。Skill 选择丢失是同一结构下的代码推断，本次只实机复现了文字草稿丢失。

应把 runtime 提升到稳定的项目 Chat 宿主，以 `projectId + conversationId` 隔离线程和草稿；URL 负责选择线程，不能靠卸载整个宿主完成切换。跨刷新草稿恢复另行定义存储策略，不能声称换上 ThreadList 就自动实现。

### 3. 核心消息能力只接了一部分

- `Chat.tsx:219` 的 `GroupedParts` 只处理 reasoning、text、tool-call，其余返回 `null`。上游 Thread 还处理 indicator、data、file、image、source 等类型。尤其等待指示与正文阅读相关，不应被通用 `return null` 一起丢弃。文件/图片类型仍需符合项目消息协议和展示策略，不能盲目打开。
- Markdown 已用 `MarkdownTextPrimitive`，但代码围栏的语言标识、单块复制、完整排版尚未采用官方 `MarkdownText`。语法高亮需另接官方 Shiki 或 SyntaxHighlighter，不能声称 MarkdownText 自带高亮。
- 已使用 `ActionBarPrimitive`，但没有配置 `hideWhenRunning`、`autohide="not-last"`；现有 CSS 把所有消息的操作栏都隐藏到 hover，包括最后一条回复。用户更难发现操作；22px 按钮也偏小。官方现有策略和 tooltip 按钮可以直接复用。
- 页面实际出现的 `[K-…]` 知识引用仍是纯文本。现有知识来源藏在工具组内的手写 `<details>`，正文引用不能直接定位来源。展示组件可以复用，引用解析与数据映射仍归平台。

依据：[MarkdownText](https://www.assistant-ui.com/elements/markdown-text)、[ActionBar](https://www.assistant-ui.com/docs/primitives/action-bar)、[Sources](https://www.assistant-ui.com/elements/sources)。

### 4. 运行恢复和取消存在未闭合的生命周期

以下来自代码，未在本轮对真实模型执行断网/取消实验：

- `ChatWorkspace.tsx:255` 只恢复持久化消息；`Chat.tsx:298` 仅将其作为初始历史，未接 resumable adapter，也没有重新订阅当前活跃 Run 的过程。打开一个仍在运行的会话，不能据此恢复真实运行态。服务端有活跃 Run 时，新发送会被 `CONVERSATION_BUSY` 拒绝。
- `Chat.tsx:311` 等待 fetch 响应头后才取得 run ID；`:339` 的提前取消设置 `pendingCancel`，期望 fetch 随后返回再补取消。但 `ComposerPrimitive.Cancel` 同时会 abort，安装的 AI SDK 确实把 `abortSignal` 传给该 fetch。若服务端已建 Run、响应头尚未到客户端，fetch 可直接 reject，补取消分支就不会执行。这是需要专门回归的取消竞态，不能把现有布尔标志当作已经解决。
- `routes.ts:359` 的 stream `cancel()` 只停止推送，不取消业务 Run。因此应继续保留服务端取消接线，并建立可在中断后定位 Run 的标识或查询方式。

官方 [Resumable Streams](https://www.assistant-ui.com/docs/guides/resumable-streams) 提供基础能力，接入仍需平台的恢复端点、身份校验和 Run 映射。平台已经保存 Run events，应先复用现有事件存储，不先新增另一套消息或流存储。

## 可以复用哪些现成组件

这里的“直接复用”指采用官方组件源码及行为，只做中文、主题、依赖路径与必要插槽适配；Elements 会进入本地源码，并不全是可从 npm 包直接 import 的成品。

| 当前部分 | 官方现成能力 | 当前状态与建议 |
| --- | --- | --- |
| 整个对话表面、阅读宽度、输入布局、空态/加载态 | [Thread](https://www.assistant-ui.com/elements/thread) | **最高优先级，采用完整组件基线。** 已有 primitives 不等于采用了完整 Thread。 |
| Markdown、代码块语言与复制 | [MarkdownText](https://www.assistant-ui.com/elements/markdown-text) | **可立即复用。** 保留当前 HTML/图片/链接策略；高亮按需接官方 renderer。 |
| 复制、更多菜单、隐藏规则、按钮 tooltip | [ActionBar](https://www.assistant-ui.com/docs/primitives/action-bar) 和 Thread 内动作组合 | **已有但未用完整。** 导出收进更多菜单；助手最后一条的常用动作可见。 |
| `/` 指令菜单 | [ComposerTriggerPopover](https://www.assistant-ui.com/elements/composer-trigger-popover) + SlashCommandAdapter | **已采用。** 保留 Skill 候选、版本 ID、多词 matcher 与结构化发送参数。 |
| 通用工具、工具分组、真实 reasoning | [ToolFallback](https://www.assistant-ui.com/elements/tool-fallback)、[ToolGroup](https://www.assistant-ui.com/elements/tool-group)、[Reasoning](https://www.assistant-ui.com/elements/reasoning) | **已采用。** 不再列为尚待替换的手写件；专用业务结果通过 renderer 扩展。 |
| 欢迎问题、后续建议 | Thread Suggestions / [Follow-up Suggestions](https://www.assistant-ui.com/elements/follow-up-suggestions) | UI 可复用；初始问题来自 Agent 的真实用途，动态建议需要实际数据源。 |
| 会话列表、切换、搜索、日期分组 | [ThreadList](https://www.assistant-ui.com/elements/thread-list) | **组件可用，接入成本中等。** 对接平台分页、Agent 选择和 URL；官方搜索不能自动覆盖尚未加载的服务端历史。 |
| 私有历史与多线程 runtime | [RemoteThreadListAdapter / ThreadHistoryAdapter](https://www.assistant-ui.com/docs/integrations/persistence/custom-adapter) | 可接自己的数据库，无须 Assistant Cloud。需适配现有 API；服务端仍是消息写入权威，不能照抄示例 append 再写一遍。 |
| 知识来源徽章与卡片 | [Sources](https://www.assistant-ui.com/elements/sources) | 复用外观，映射现有 citationId/filename/ordinal/content。Source part 不会自动解析正文 `[K-…]`，原文片段和权限仍需业务适配。 |
| 选中文字后引用提问 | [Quote](https://www.assistant-ui.com/elements/quote) | 前端选区/预览可复用；需将 quote 传输给服务端。当前路由去掉 metadata 且只提取末条 text，直接挂组件会漏掉引用语义。 |
| 附件选择、拖放、预览、移除 | [Attachment](https://www.assistant-ui.com/docs/guides/attachments) | UI 不必自写。当前 chat 路由拒绝非 text part，需先补上传、授权、消息协议和模型支持。 |
| 编辑提问、重新生成、分支导航 | [BranchPicker](https://www.assistant-ui.com/docs/guides/branching) + Edit/Reload | UI 不必自写；当前后端没有分支处理，不应直接启用。 |
| 朗读、语音输入、输入历史、耗时 | 现有 voice adapters、Composer/ActionBar primitives、timing hook | **本地已有。** 属于补充能力，不作为本次主要改进目标；耗时与 token usage 区分数据来源。 |

## 不能靠换组件解决的部分

1. **编辑/重试协议。** `routes.ts:264` 虽接受 `trigger/messageId`，但后续只读取末条 user 文本；`conversations.ts:128` 按请求 ID 幂等并另生成服务端 user message ID。直接开启 Edit/Reload 可能遇到末条消息校验、旧 Run 重放或幂等冲突，不能凭按钮出现就认为可用。
2. **附件与引用协议。** 当前只接受文本，且客户端 metadata 不直接成为请求上下文。组件支持不代表后端已支持。
3. **会话管理。** 当前 API 有列出、创建、读取、删除，没有对应的重命名/归档路由。ThreadList 这些动作应先隐藏或补齐契约；删除目前还会删除运行记录，必须保留现有语义提示。
4. **平台边界。** 项目授权、发布版本固定、Skill 授权、Run 排队与取消、轨迹审计、真实 usage 由平台负责。官方 [Mastra 独立服务示例](https://www.assistant-ui.com/docs/integrations/frameworks/mastra/separate-server) 验证了相同的 AI SDK 前端接入方向，但不是绕过平台控制面的理由。

## 建议实施顺序

### 第一批：完整替换对话表面，交付可见变化

- 从固定上游引入 Thread、MarkdownText 及配套 UI/registry 样式，沿用当前 `shared/assistant-ui/UPSTREAM.md` 的来源记录方式。
- 主内容和 Composer 共用居中阅读列；桌面中文正文先以 15–16px 验证，用户提问与助手回复建立明确层级；保留平台绿色主题。
- 工具入口聚合在 Composer 左侧，发送/停止固定右侧。复制保持容易发现，导出/朗读等放次级动作，采用官方显示策略。
- 接入真实 Agent 欢迎内容、历史加载骨架和运行指示。知识引用提供可定位来源的入口；轨迹入口保留为辅助操作。
- 使用上游真实插槽：固定源码支持 Welcome、AssistantMessage、ToolFallback、ToolGroup、ReasoningGroup；**没有 Composer 插槽**。Skill 输入与平台 cancel 需在复制源码的 Composer 中作小范围接线，不能虚构 `<Thread components={{ Composer }}>`。
- 当前已有 Tailwind、Radix、lucide 等基础，不需要再搭一套 UI 基础。引入新文件时同步扩展局部样式扫描范围，避免把全局 reset 加到 AntD 页面。

### 第二批：统一会话生命周期

- 提升稳定的 Chat runtime 宿主，接 ThreadList adapter，统一 URL、平台 ID 与 runtime thread ID 的映射。
- 明确每线程草稿/Skill 选择的归属；消息历史从服务端加载，实时消息由 runtime 管理，不新增平行的 messages 状态副本。
- 接活跃 Run 查询和流恢复，解决提前取消、切换后取消以及断线后状态同步；确保恢复不是重新执行工具。
- 分页和删除仍对接平台 API；重命名、归档在服务端支持后开启。

### 第三批：补齐有后端前提的能力

编辑/重新生成/分支、附件、引用提问按各自契约推进。通用 UI 继续直接取官方组件，业务只实现 adapter 与专用 renderer。

## 验收边界

- 已实机确认：当前排版、工具分组入口、现有消息动作，以及 A → B → A 的文字草稿丢失。
- 本轮不发送模型请求，不据此声称验证了流式停止、断网恢复、语音或附件。
- 改造验收应覆盖：宽屏长文和表格、长代码块、滚动中持续生成、最后回复操作可见、IME 与 `/` 菜单、草稿切换保留、生成中切换/返回、响应头前取消、恢复后不重复执行、失败后的可理解恢复入口。
- 既有 `chat-commands` 和 `chat-assistant-ui` 测试覆盖指令选择、工具折叠、输入历史和部分语音/流式字段约束；它们没有证明上述会话连续性与视觉目标。
- 本轮重新执行这两个测试文件，6/6 通过。审查仅新增本文，产品工作区中的既有改动未由本轮修改。
