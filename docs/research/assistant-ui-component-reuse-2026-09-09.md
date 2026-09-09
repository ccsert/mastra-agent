# assistant-ui 现成组件复用核对

日期：2026-09-09。产品基线：`c85097f`。本次只调研和核对源码，未修改产品代码，也未把官方示例运行效果当成本项目验收结果。

结论：当前手写的快捷菜单、默认展开的工具 JSON 卡片，应替换为 assistant-ui 已提供的组件组合。项目已经安装的 `@assistant-ui/react@0.15.18` 就包含所需行为 API，无须以升级依赖为前提。平台只保留 Skill 版本选择、授权、专用工具结果展示与持久化适配。官方 Elements 是可安装进项目的源码组件，不是所有组件都能直接从 `@assistant-ui/react` 导入。

## 核对基线

- 官方仓库本次核对固定为 [`3a45a01c0d6141102638ecd4f32d1af4d01fb510`](https://github.com/assistant-ui/assistant-ui/tree/3a45a01c0d6141102638ecd4f32d1af4d01fb510)。该版本 [`packages/react/package.json`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/react/package.json) 也是 `0.15.18`。
- 本地 `apps/console/package.json`：`@assistant-ui/react@0.15.18`、`@assistant-ui/ai-sdk@0.0.4`、`@assistant-ui/react-markdown@0.14.14`、React `19.2.8`。已直接读取安装包 `src/unstable/useSlashCommandAdapter.ts`、`src/primitives/composer.ts`、`src/primitives/message/MessageParts.tsx`、trigger 实现。
- 官方文档在线查阅；所有实现建议以固定源码与本地 API 的交集为准。官方 registry URL 本次返回 HTTP 403，不能声称成功执行过 registry 安装。对应组件源码已从同一官方仓库固定 SHA 读取，可采用可追溯的源码引入方式。
- 不需要替换现有 `AssistantChatTransport`、服务端 Run 或会话模型。现有传输、取消、版本授权逻辑必须保留。

## 现有实现与现成替代

| 当前代码/能力 | 官方可复用项 | 接入方式与平台责任 |
| --- | --- | --- |
| `ChatComposer.tsx` 手写菜单、highlight、键盘、ARIA、过滤 | `unstable_useSlashCommandAdapter` + `ComposerTriggerPopover` | 官方负责交互；平台给出已授权的 Skill 候选及选中回调。低到中等改动。 |
| Tag 中选中的 Skill | 命令 `Action` 的 `removeOnExecute`；或 Mention + Lexical 芯片 | 当前选中 IDs 的传输契约可保留，用 Action 选择后移除指令输入。后续要正文内上下文引用时再用 Mention/Lexical。 |
| 通用 `ToolCard` 的 `<details open>` | `ToolFallback` | 接收完整工具 part，已有折叠、进行中、失败、取消、待确认展示。保留知识库专用 renderer。 |
| 工具逐项铺平 | `MessagePrimitive.GroupedParts`、`groupPartByType`、`ToolGroupRoot/Trigger/Content` | 按相邻工具 part 分组，使用真实状态；不需要自己再按消息序号拼组。 |
| reasoning part 当前被忽略 | `ReasoningRoot/Trigger/Content/Text`、`Reasoning` | 显示模型实际发出的 reasoning；没有该 part 时不渲染，也不合成模型推理。 |
| 消息复制/编辑/重试等 | `ActionBarPrimitive`；官方 Thread 的 action bar 组合 | 复制可直接用；编辑/重试/分支必须先核对平台持久化语义。 |
| 文件附件 | `ComposerPrimitive.AddAttachment/Attachments/AttachmentDropzone` 与官方 Attachment 组件 | 不再自己写文件选择器/移除卡片；上传、存储位置、权限与模型支持仍需平台 adapter。 |
| 上下文实体引用 | `unstable_useMentionAdapter`、`unstable_useLiveCompletionAdapter`、`DirectiveText` | 可用于 Skill、知识库、文件等候选；Mention 本身不等于后端资源授权。 |

各能力的官方入口：[Slash Commands](https://www.assistant-ui.com/docs/guides/slash-commands)、[Composer Trigger Popover](https://www.assistant-ui.com/elements/composer-trigger-popover)、[Tool Fallback](https://www.assistant-ui.com/elements/tool-fallback)、[Tool Group](https://www.assistant-ui.com/elements/tool-group)、[Reasoning](https://www.assistant-ui.com/elements/reasoning)、[File Attachments](https://www.assistant-ui.com/docs/guides/attachments)、[Mentions](https://www.assistant-ui.com/docs/guides/mentions)。

## 快捷指令：删除手写菜单状态，复用官方组合

官方 hook 的真实类型：`Unstable_SlashCommand` 包含 `id`、可选 `label/description/icon`、必需 `execute: () => void`。`unstable_useSlashCommandAdapter` 返回 `{ adapter, action, iconMap?, fallbackIcon? }`。`removeOnExecute: true` 会在选择后移除匹配的触发文本，再调用回调。源码见 [`useSlashCommandAdapter.ts`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/react/src/unstable/useSlashCommandAdapter.ts) 与 [`triggerSelectionResource.ts`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/react/src/primitives/composer/trigger/triggerSelectionResource.ts)。

建议接入流程：

1. 从现有 `getConversationCapabilities` 结果产生命令。`id` 关联 `skillVersionId`，`label` 展示名称，description 展示固定版本与用途。
2. `execute` 仅加入本次 `selectedSkillVersionIds`，不直接调用业务工具，也不自动发送消息。选择数上限继续为 10；执行回调再次检查版本仍可选。
3. 在 composer 外层挂一个 `ComposerPrimitive.Unstable_TriggerPopoverRoot`，其中保留 `ComposerPrimitive.Root/Input/Send`，挂官方 `ComposerTriggerPopover char="/" {...slash}`。
4. 用官方组件的 `backLabel/emptyCategoriesLabel/emptyItemsLabel/loadingLabel` 实现中文空态与加载态，删除当前 `opened/dismissed/active/current` 和 Arrow/Enter/Escape 自管代码。
5. 保留 `AssistantChatTransport.body()` 中结构化的 `skillVersionIds`，以及后端版本快照、停用校验、跨项目拒绝、幂等与取消契约。

组件源码：[`composer-trigger-popover.aui.tsx`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/composer-trigger-popover.aui.tsx)。它已经组合 Categories、Back、Items、Item 与 Directive/Action；只允许传入 `directive`、`action` 中的一个。

必须处理的真实差异：

- **没有 `Unstable_SlashCommand.disabled` 字段。** 失效/已选/超限候选应从 adapter 可选数据中排除，旁边说明不可选原因。仅给按钮 `disabled` 不足以保证键盘不会触发：导航资源选的是 item，不是 DOM button。不能虚构一个 `disabled` API。
- **默认 matcher 不允许空白 query。** 当前 `/skill report` 在默认行为下会因空格关闭。保留此交互时，通过公开 `Unstable_TriggerMatcher` 实现很小的多词匹配，返回 `{ query, offset, endOffset }`；遵守光标位置、Escape 后光标前移、只替换匹配片段。官方负责剩余选择行为。源码见 [`detectTrigger.ts`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/react/src/primitives/composer/trigger/detectTrigger.ts)。
- **官方 Popover 不是防碰撞定位引擎。** 固定源码的容器采用 `absolute`、`bottom-full`、默认 `w-64`；应以 composer 作为正确定位容器并限制桌面高度/滚动。不能声称安装后自动处理所有窗口边缘或遮挡。
- API 显式标为 unstable。应在 Chat 的适配模块收口，锁定依赖版本并覆盖真实交互回归；没有理由继续维护另一套等价键盘状态机。

### Mention 与 Skill 选择的边界

官方 Mention 支持平铺、分组、同步及异步来源，选择后在输入中插入 directive。默认格式为 `:type[label]{name=id}`。`ComposerPrimitive.Input` 是 textarea，所以展示序列化文本；如要输入框里原子化可删除的芯片，要采用 `@assistant-ui/react-lexical` 的 `LexicalComposerInput`，并安装 `lexical/@lexical/react`。消息中可采用 `DirectiveText` 或 `createDirectiveText`。这是官方现有能力，不应自己写 contenteditable 芯片编辑器。[官方 Mention 指南](https://www.assistant-ui.com/docs/guides/mentions)、[固定 DirectiveText 源码](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/directive-text.aui.tsx)

当前“给本次任务指定 Skill”优先用 Action，保留结构化参数。将来 `@文件/@知识库` 如采用 directive，需要由服务端把引用解析为受授权的资源快照；不能因为字符串出现在消息中就赋予访问权。`includeModelContextTools` 也只提供注册工具的前端选择数据，不替代平台 ToolGrant。

## 工具与执行过程：使用官方 renderer 和分组

`Chat.tsx` 当前通用卡片只根据 `result === undefined` 判断状态，可能把取消或失败误展示为持续执行中；并始终展开全部 JSON。官方 `ToolFallback` 接收完整工具 part，包括 `argsText/result/status/approval/interrupt` 及相应回调，默认折叠，在需要用户动作时展开。它使用 `useScrollLock` 防止折叠动画导致阅读位置跳动；只有存在 recorded timing 时才显示 `useToolCallElapsed` 计时。[固定 ToolFallback 源码](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/tool-fallback.aui.tsx)

建议：

- 通用工具直接交给 `ToolFallback`，传完整 part，保留流式 `argsText`。
- `knowledge_search` 保留专用知识来源展示，可以放入官方折叠容器。不要为每种 tool 重做通用状态与折叠逻辑。
- 按官方 Thread 源码使用 `MessagePrimitive.GroupedParts` 和 `groupPartByType`。相邻 reasoning/tool-call 可以在同一个外层过程组下，内部再分 reasoning 与 tools。工具分组用官方 `ToolGroupRoot/Trigger/Content`，数量来自 `part.indices.length`，运行中来自 `part.status.type`。
- reasoning 用官方 `ReasoningRoot streaming={...}` 组合。它有流式预览、用户手动折叠接管、流结束恢复等现成行为，不需要自建一个“思考中”假过程。
- 保留现有安全 Markdown 渲染策略，包括禁止原始 HTML、外部图片处理与链接策略；引入官方模板不能悄悄放宽。

固定参考：[`thread.aui.tsx`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx)、[`tool-group.aui.tsx`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/tool-group.aui.tsx)、[`reasoning.aui.tsx`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/reasoning.aui.tsx)、[`reasoning.tsx`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/reasoning.tsx)。

### 不要选择旧 API 作为新实现主线

本地确实还有 `ChainOfThoughtPrimitive`，但“存在”不代表应作为新主线。官方最新指南明确 `MessagePrimitive.Parts` 的 `components.ChainOfThought` 及 `ChainOfThoughtPrimitive.Parts.components` 为 legacy，新代码应使用 `MessagePrimitive.GroupedParts`。旧 `ToolGroup`/`ReasoningGroup` 包装仍为兼容导出；优先采用 Root/Trigger/Content 和新分组入口。[官方 Chain of Thought 指南](https://www.assistant-ui.com/docs/guides/chain-of-thought)

这套组件解决 Chat 内消息 part 的呈现，不能代替平台完整 Run 的服务端轨迹。跨服务父子调用、审计、获准内容、历史分页、真实 Token 与耗时仍需平台事件数据；DeepSeek Harness 的本地实机对照由另一个工作流完成，本文不据 assistant-ui 的折叠组件推定 DSH 设计。

## 消息动作、附件、上下文

**消息动作。** `ActionBarPrimitive.Root/Copy/Edit/Reload` 有现成运行态/hover 可见性和 action wiring；官方 Thread 还使用 `ExportMarkdown`。本项目可以先复用 Copy。直接挂上 Edit/Reload 会触发运行时操作，必须先让服务端的消息身份、历史分支和 Run 对应关系正确，不能只让客户端看起来支持。[官方 ActionBar API](https://www.assistant-ui.com/docs/api-reference/primitives/action-bar)、[Thread 固定源码](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx)

**附件。** 官方已提供选择、拖放、列表、移除、上传状态与预览组件，包含 `AttachmentPrimitive`、`ComposerPrimitive` 的相关 API。需要本平台实现受权限约束的 AttachmentAdapter 与文件上传/解析/存储生命周期，接到现有知识库或运行输入；不要默认使用把文件内容直接送外部模型的适配方式。[官方附件指南](https://www.assistant-ui.com/docs/guides/attachments)、[固定 Attachment 源码](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/assistant-ui/elements/attachment.aui.tsx)

**上下文用量不是上下文选择。** `ContextDisplay` 是现成 Token 用量展示，要求后端真的传 usage/model 信息；未提供时应无数据，不以估算或固定样例充数。可选择资源应使用 Mention/业务选择器，不能把 ContextDisplay 当 Skill selector。[官方 ContextDisplay](https://www.assistant-ui.com/elements/context-display)

## 引入现成源码的工程方式

项目当前为 AntD + 普通 CSS，没有 Tailwind 或 shadcn 基础组件。官方 `.aui.tsx` 组件使用 Tailwind classes，并引用 `cn`、图标、Collapsible；ToolFallback 还引用 Button/Textarea，Reasoning 引用 Markdown 与样式组件。因此“把一个 import 改名”不构成完整安装。

本轮进一步确定采用官方 Elements 源码复制模式：保留来自固定 SHA 的组件结构、Tailwind utility classes 与基础组件，放到独立的 assistant-ui 组件目录，记录来源/许可证；只改中文文案、项目 import 路径、主题与业务接线。官方 Trigger/GroupedParts/ScrollLock 保持直接使用安装包。通过 Tailwind 的 theme/utilities 分开导入，不导入全局 Preflight；扫描范围收敛到引入的组件及 Chat，主题变量放在 Chat 容器。这样可以保留官方视觉实现，不必把它们再次翻译成一套手写 CSS。此项是实现方案，仍须验证产物与 AntD 的样式共存。

### 已取到的最小官方源码与依赖

官方 [`apps/registry/src/registry.ts`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/apps/registry/src/registry.ts) 是此次依赖核对的依据；不能只复制 TSX 而漏掉 registry 注入的 CSS。所有文件本次已下载到 `/tmp/assistant-ui-reuse-source/`，文件名用 `__` 替换路径分隔符。

| 组件 | npm 依赖（已有 React 等不重复） | 需要一同引入的官方源码 |
| --- | --- | --- |
| ComposerTriggerPopover | `lucide-react`、`cn` | `composer-trigger-popover.aui.tsx`、`src/lib/utils.ts` |
| ToolFallback | `radix-ui`、`lucide-react`、`class-variance-authority`、`cn`、`tw-shimmer` | `tool-fallback.aui.tsx`、`ui/radix/button.tsx`、`ui/radix/collapsible.tsx`、`ui/radix/textarea.tsx` |
| ToolGroup | 上述依赖即可 | `tool-group.aui.tsx`；实际使用 Root/Trigger/Content，不使用旧包装 |
| Reasoning | 上述依赖 + 已有 `@assistant-ui/react-markdown`、`remark-gfm` | `reasoning.aui.tsx`、`reasoning.tsx`、`markdown-text.tsx`、`tooltip-icon-button.radix.tsx`、`ui/radix/tooltip.tsx`、`hooks/use-copy-to-clipboard.ts` |
| 样式构建 | Tailwind v4 对应 Vite/PostCSS 插件、`tw-animate-css` | 官方 template 的 theme 映射、必要的动画；不复制全局 body/reset |

`cn` 不是必须自己写的 util；官方 `src/lib/utils.ts` 只有从 npm 包 `cn` 再导出的语句。官方仓库 [`packages/ui/package.json`](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/package.json) 使用 `cn ^0.2.6`、`lucide-react ^1.41.0`、`class-variance-authority ^0.7.1`、`radix-ui ^1.6.7`。这些是来源版本范围，项目新增时仍应锁定实际解析版本。`@assistant-ui/ui` 本身是私有 workspace，不能作为可安装 npm UI 包来依赖。

官方同时有 Base UI/Radix 两套基础组件。当前应用没有 Base UI，而安装的 assistant-ui 已依赖 Radix；本轮可选官方 Radix 源。必须成套使用：`TooltipIconButton` 的默认源码走 Base UI 的 `render`，若选择 Radix，要使用 `tooltip-icon-button.radix.tsx`，不能混搭。基础文件路径全部位于 [`packages/ui/src/components/react/ui/radix`](https://github.com/assistant-ui/assistant-ui/tree/3a45a01c0d6141102638ecd4f32d1af4d01fb510/packages/ui/src/components/react/ui/radix)。[官方 Base UI/Radix 说明](https://www.assistant-ui.com/docs/base-ui)

### 样式的不可遗漏项

- registry 为 ToolFallback/ToolGroup/Reasoning 加入 `tw-shimmer`，以及 `data-open`、`data-closed` custom variants。它们兼容 Radix 的 `data-state` 与 Base UI 的 state attributes。
- 还加入 `collapsible-down/up` keyframes，高度读取 `--radix-collapsible-content-height` 或 `--collapsible-panel-height`。ToolGroup 子项的 `animate-in`、`fade-in`、`slide-in` 等使用 `tw-animate-css`，不能以只安装 Tailwind 为完成。
- 主题采用官方 template 的 color/radius 映射，值在 Chat 容器对齐平台主题。最少需要 background/foreground/popover/primary/muted/accent/destructive/border/input/ring 及对应 foreground 变量；不要把示例 `:root`、`body` 的样式直接施加全站。
- 不含 Preflight 时，浏览器原生 button、pre、border 默认值仍存在。验收要检查官方按钮边框/背景、JSON 容器溢出和排版，不把缺样式判成组件算法问题。如需局部基础样式，应限制在官方组件根容器。

参考：[官方 template 样式](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/templates/default/app/globals.css)、[官方 template 依赖](https://github.com/assistant-ui/assistant-ui/blob/3a45a01c0d6141102638ecd4f32d1af4d01fb510/templates/default/package.json)、[Tailwind 官方 Preflight 导入说明](https://tailwindcss.com/docs/preflight)。

这一轮应优先完成：

1. 官方 ComposerTriggerPopover + SlashCommandAdapter 替换手写菜单，保留当前 Skill 结构化调用链。
2. 官方 ToolFallback + GroupedParts + ToolGroup 替换通用工具展示，保留专用知识来源卡和运行详情链接。
3. 接入模型真实 reasoning 的官方 renderer，并明确缺少字段时不展示。
4. 浏览器完成 `/`、多词 query、鼠标/键盘、IME、选择后编辑、失败/取消、工具组折叠、长输入与历史恢复验收。测试要覆盖交互语义而不是只检查出现了组件名称。

本次结论来自官方文档、固定源码与安装包核对；未安装 registry、未完成新 UI 视觉验收，也未修改 Agent/Runtime 业务能力。
