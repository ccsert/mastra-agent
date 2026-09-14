# assistant-ui Elements 来源与维护

本目录按官方 Elements 的源码引入方式维护。来源为 [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui/tree/3a45a01c0d6141102638ecd4f32d1af4d01fb510)，固定提交 `3a45a01c0d6141102638ecd4f32d1af4d01fb510`，首次引入日期 2026-09-09，2026-09-11 补入完整 Thread 与 MarkdownText。MIT 许可证见同目录 `LICENSE`。

| 本地文件 | 官方仓库路径 |
| --- | --- |
| `elements/thread.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx` |
| `elements/markdown-text.tsx` | `packages/ui/src/components/react/assistant-ui/elements/markdown-text.tsx` |
| `elements/tooltip-icon-button.tsx` | `packages/ui/src/components/react/assistant-ui/elements/tooltip-icon-button.radix.tsx` |
| `elements/composer-trigger-popover.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/composer-trigger-popover.aui.tsx` |
| `elements/tool-fallback.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/tool-fallback.aui.tsx` |
| `elements/tool-group.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/tool-group.aui.tsx` |
| `elements/reasoning.tsx` | `packages/ui/src/components/react/assistant-ui/elements/reasoning.tsx` |
| `elements/reasoning.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/reasoning.aui.tsx` |
| `ui/{button,collapsible,textarea,tooltip,skeleton}.tsx` | `packages/ui/src/components/react/ui/radix/` 下同名文件 |
| `hooks/use-copy-to-clipboard.ts` | `packages/ui/src/hooks/use-copy-to-clipboard.ts` |
| `utils.ts` | `packages/ui/src/lib/utils.ts` |

本地适配：调整相对导入路径、常用展示文案中文化、使用安全回退代替非空断言、按本项目格式化。保留官方组件结构、交互 hook、状态处理和 utility classes。未使用兼容旧 API 的 ToolGroup 包装；Chat 通过 `MessagePrimitive.GroupedParts` 组合 Root/Trigger/Content。

Thread 的 `composer`、`footer` props 与 `UserFooter`、`AssistantFooter`、`AssistantActions`、`AssistantBody` slots 是本地扩展，并非上游现成 API。业务上下文、知识来源、轨迹入口和语音适配在 Chat feature 内实现；共享组件不依赖平台接口。Thread 默认采用 50rem 阅读列，保留上游视口、工具/reasoning 分组、等待指示与动作栏显示规则。用户消息通过原生 ActionBar.Edit 和 Composer 编辑，新增本地 EditComposer 插槽连接服务端分支协议：编辑后以该消息前的历史创建分支，原会话保留，失败可幂等重试。附件与重新生成仍未接入。

2026-09-12 修复悬停抖动：ActionBar 在隐藏时会卸载，因此助手回复为操作栏独立预留完整的 32px 行，业务元数据单独排布；移除上游 30px 的 padding/负 margin 配对。这与本地放大的按钮尺寸保持一致，避免显隐增高或元数据换行引发重排。升级时应在真实浏览器中比较显隐前后的消息高度、后续消息位置和滚动高度，而不能仅检查按钮是否出现。

MarkdownText 保留上游排版和代码块复制，使用当前项目的 `skipHtml`、外部图片转 alt 文本、新窗口链接 `noreferrer` 策略。未开启延迟渲染或语法高亮。移除模块级 CSS 导入，相关样式集中在本目录 `styles.css`；TooltipIconButton 使用 32px 点击区域并设置明确的 `aria-label`。

`styles.css` 是本项目接入文件：只扫描上述 Elements/UI 的 Tailwind utilities，不引入全局 Preflight；带入官方 registry 的 data-open/data-closed variants、折叠动画、tw-animate-css 和 tw-shimmer。颜色映射到平台主题；组件容器内补充按钮基础样式、快捷菜单宽高与长结果滚动。未引入官方全站 body/reset 样式。

Skill 版本候选、数量上限、选中 IDs 和 `/name`、`/skill 多词查询` matcher 留在 Chat feature；斜杠菜单的键盘、Escape、IME 和选择移除行为由官方 Composer 实现。Skills 按钮使用 Ant Design Popover/Input 提供可搜索、多选且不改写正文的面板。通过原生 `isSendDisabled` 和 `toCreateMessage` 扩展点，把可用性校验与当前用户消息的指定版本接入原有 runtime，不另建消息状态。授权与取消继续走现有服务端契约。ToolFallback 中保留的可选审批 UI 不代表平台已经接通该审批协议；平台当前没有把审批事件接入此组件。

Skill 的实际调用内容由 Chat feature 的 `ChatToolContent` 按已记录的输入/输出渲染，使用 Ant Design Tabs 和现有 Markdown/结构化结果组件。共享入口导出已有 `useCopyToClipboard`，用于复制精确原文；没有新增副本或依赖。手动指定标签只表示用户意图，不冒充实际加载记录。

升级时先比较固定上游文件和 registry 样式，再核对安装包 API；重点回归指令选择不发送消息、不丢正文、工具分组折叠、失败详情、代码复制和历史恢复，以及受局部 Tailwind 与平台样式共同影响的宽窄屏布局。当前 `@assistant-ui/react` 固定为 `0.15.18`，Trigger API 仍标为 unstable。调研记录见 `docs/research/assistant-ui-component-reuse-2026-09-09.md` 和 `docs/research/assistant-ui-chat-audit-2026-09-11.md`。

### Agent plan (2026-09-12)

Adapted the MIT `AgentPlan` element from assistant-ui commit `4e5fde6c2d09909c5b286fee098c9950615a26d3`, source: https://github.com/assistant-ui/assistant-ui/blob/4e5fde6c2d09909c5b286fee098c9950615a26d3/packages/ui/src/components/react/assistant-ui/elements/agent-plan.tsx .

Local changes: Chinese labels, stable item IDs, explicit independent statuses (including parallel, blocked and cancelled tasks), recorded revision, accessible progress count, and local theme styles. Never infer task completion from its index or the parent run's terminal status. Existing assistant-ui tool roots/triggers/content and scroll locking are reused for the richer backend tool renderers.


### 紧凑过程行（2026-09-12）

本地为 Thread 增加 `maxWidth`，Chat 使用 68rem；ReasoningTrigger 增加 `label/summary`，ToolFallback.Trigger 增加 `label/summary/outcome/icon`，均保留默认上游行为。Chat 通过现有 `ReasoningGroup` 和 `ToolGroup` slots 提供 28px 过程行：思考初始收起，流式预览最新行，结束后取第一行；受控展开状态不随 token 或终态覆盖用户选择，展开后仍复用原生正文渲染与滚动锁。工具逐个展示并复用原生 Root/Trigger/Content，移除聊天中的重复计数折叠层。审批分支仍使用完整原生 ToolFallback。

动作语义、参数摘要、子代理结果、计划版本和轨迹链接均在 Chat feature 中组合。业务 CSS 收紧布局，不改变共享组件的默认外观；操作栏的 32px 占位继续保留。此适配没有引入额外组件库或第二套消息状态。

2026-09-13：恢复接入使用安装包原生 `AssistantChatTransport.resumable`、`ResumableClientStorage` 和 `useAISDKChat`；平台只提供事件回放接口与账号隔离草稿。`AssistantBody` 是本地组合插槽，用于轮次过程摘要和成果/子任务工作区，不复制上游消息运行时。

2026-09-13：过程图标按思考、计划、Skill、文件、命令、浏览器和子代理分类，身份图标与小尺寸状态标识分离，固定尺寸不改变操作栏布局。网页截图与隔离产物预览放在 Chat feature，原生工具状态与内容折叠继续复用。
