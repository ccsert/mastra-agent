# 对话界面 assistant-ui 复用率补齐

日期：2026-09-11。基线：`6a2ff15`。本文含三轮，都在同一天、同一个目标下：「少自写、多用现成组件」。第一轮替换 Chat 里 4 处手写件；第二轮把 Composer 迁入 `ThreadPrimitive.ViewportFooter`，并因此**推翻了第一轮对 `ViewportFooter` 的不采用结论**（依据见下文）；第三轮按官方文档逐个能力核对，落地 4 项**界面可见**的复用（前两轮都是结构性的，按定义看不到变化）。

依赖不变：`@assistant-ui/react@0.15.18`、`@assistant-ui/ai-sdk@0.0.4`、`@assistant-ui/react-markdown@0.14.14`。上游源码引入目录 `apps/console/src/shared/assistant-ui/` 三轮均未新增文件。

## 第一轮替换

| 原手写件 | 上游组件 | 行为差异 |
| --- | --- | --- |
| `Chat.tsx` 的 `ScrollToBottom` 包装：自己订阅视口状态、`isAtBottom` 为真时返回 `null` 不渲染 | `ThreadPrimitive.ScrollToBottom` | 上游已自带该判断：`useThreadScrollToBottom` 在 `isAtBottom` 时把回调置 `null`，`createActionButton` 据此渲染**禁用**按钮（不是不渲染）。因此可见性改由 CSS `.chat-to-bottom:disabled { visibility: hidden }` 承担，与官方 thread 的 `disabled:invisible` 等价，删掉本地一份视口状态推导。 |
| `AssistantMessage` 里 `MessagePrimitive.Error` 内的固定中文错误文案 | `ErrorPrimitive.Root` + `ErrorPrimitive.Message` | 上游 `messageErrorText` 只在消息状态为 `incomplete / reason: error` 时取值，并按 `error.message` 取真实失败原因；渲染条件与原来一致，但不再是固定句子。仅当运行时把错误挂到该条 assistant 消息时才渲染；传输层失败仍然由 `composer-area` 的 `Alert` 显示，两者并存。 |
| `ChatComposer.tsx` 手写停止按钮（本地 `useAuiState` 订阅运行态 + 自绘 `button`） | `ComposerPrimitive.Cancel` | 组件的启用态由 `composer.canCancel` 决定，点击经 `createActionButton` 的 `composeEventHandlers` 与原生 cancel 合并，本地 `onClick` 继续负责取消平台 Run。与官方 thread 的 `AuiIf{running} → Cancel` / `AuiIf{!running} → Send` 结构一致。 |
| 消息动作栏只有 Copy | 追加 `ActionBarPrimitive.ExportMarkdown` | 纯客户端行为（`getCopyText()` → Blob 下载），不涉及服务端持久化，没有可以出错的写入语义。 |

## 保留的平台语义

停止生成不能只断流。控制面 `streamConversation` 的 ReadableStream `cancel()` 只停止推送，Run 会继续执行；真正取消必须调 `cancelRun`（operationId `cancelConversation`）。当前实现：

1. `ChatComposer` 只声明 `cancelRun(): void`，文案注释说明这一点；`ComposerPrimitive.Cancel` 的 `onClick` 调它。
2. `Chat.cancelPlatformRun()` 先置 `cancelled.current = true`，再调接口，成功后 `onFinish()`。
3. run id 来自响应头 `x-platform-run-id`。若取消发生在响应头到达之前，置 `pendingCancel.current`，由 `fetch` 包装在拿到响应头后补调。
4. 取消会 abort 流，该 abort 会走 `onError`。`cancelled.current` 为真时直接返回，不把用户主动取消报成失败。

## 第二轮：Composer 迁入 ViewportFooter（已实施）

第一轮判定「不采用 `ViewportFooter`」。复核上游源码后该结论不成立，本轮已改。推翻的依据是 `contentInset` 的真实语义：

```ts
// @assistant-ui/store/dist/utils/viewport-scroll.js
/**
 * With a content inset, positions within `contentInset` of the native bottom
 * count as at bottom: content that close is only obscured by the inset
 * element itself, so the viewport is still treated as pinned.
 */
export const isViewportAtBottom = (metrics, contentInset = 0) => { ... }
```

`ViewportFooter` 测量 `el.offsetHeight + marginTop` 并注册为 `contentInset`（`ThreadViewportFooter.js` → `registerContentInset`）。这个测量**不是**为了让 `scrollToBottom` 算得更准——`useThreadViewportAutoScroll` 的 `scrollToBottom` 直接 `div.scrollTo({ top: div.scrollHeight })`，与 inset 无关。它服务的是 `isViewportAtBottom` / `viewportOverflows`：当 footer **遮挡**视口底部时，把「距底 ≤ 遮挡高度」也算作贴底，避免用户已经滚到底却因为没有像素级贴底而被判定成「不在底部」（表现为「回到底部」按钮不消失）。

所以第一轮「Composer 不遮挡，所以不需要」的判断在**当时是对的**——但代价是它同时否掉了把 Composer 放进视口这个更标准的结构。本轮改为官方结构，遮挡被引入，`contentInset` 恰好负责消解它，净效果是删掉了 `.chat-scroll-slot` 那个 `sticky + height: 0` 的自定义浮层技巧。

### 结构变化

```text
之前                                  之后（官方 thread 结构）
ThreadPrimitive.Root                  ThreadPrimitive.Root
└─ ThreadPrimitive.Viewport           └─ ThreadPrimitive.Viewport        （滚动容器）
   ├─ Empty                             ├─ div.chat-viewport-content    （flex:1，撑起上方空间）
   ├─ Messages                          │  ├─ Empty
   └─ ScrollToBottom                    │  └─ Messages
└─ div.composer-area  ← 视口外         └─ ThreadPrimitive.ViewportFooter  （sticky bottom-0）
   ├─ ScrollToBottom                      ├─ ScrollToBottom
   ├─ Alert                               ├─ Alert
   ├─ Composer                            ├─ Composer
   └─ footnote                            └─ footnote
```

配套样式要点：

- `.chat-viewport` 变 `display: flex; flex-direction: column`，左右/上内边距移交内容容器，它不再自己带 padding。
- `.chat-viewport-content` 承担 `padding: 24px 28px 0` 与 `flex: 1`，把 footer 推到下方（配合 footer 的 `margin-top: auto`）。
- `.composer-area` 变 `position: sticky; bottom: 0; z-index: 5; margin-top: auto; padding: 12px 24px`。背景必须保持不透明——它正是遮挡穿过其下方内容的那一层。
- `.chat-scroll-slot` 由 `sticky + height: 0` 改为 `position: absolute; top: -44px`，浮在 footer 上方；槽位铺满整宽但 `pointer-events: none`，只有按钮本身 `pointer-events: auto` 接收点击。
- `.chat-welcome` 的 `height: 100%` 改 `flex: 1`：内容容器现在是 flex 列，百分比高度不成立而 flex 成立。
- 响应式里原 `.chat-viewport` 的 padding 规则（1150px / 600px 两处）改指向 `.chat-viewport-content`；600px 下 `.composer-area` 改对称 `padding: 10px 12px`。

### 这次重构的收益与代价

收益：删掉自定义浮层技巧；滚动容器内只有「内容 + 页脚」两个参与者，`.chat-thread` 不再需要同时容纳滚动区与固定区。

代价：Composer 现在**遮挡**视口底部。这依赖 `contentInset` 正确上报才能保持「贴底」判定正确，而该上报依赖 `ResizeObserver`。因此这次改动是**必须实机验证**的：不能只看测试通过。需要确认的点是 Composer 常驻可见且贴底、内容在其下方滚动、滚到底时「回到底部」按钮消失、以及空会话欢迎语垂直居中。

## 第三轮：读文档找「看得见」的复用点（已实施）

第二轮的结论是结构重构，按定义不该有可见变化——用户反馈「看起来似乎没有什么变化」是对的，这一点上一轮没有讲清楚。本轮改为按官方文档逐个能力核对，只挑**同时满足**三个条件的：在 0.15.18 里真实存在、纯前端即可工作（不新增后端契约）、用户能在界面上看到或用到。

文档入口：`https://www.assistant-ui.com/docs/` 站有 `llms.txt` 索引与 `llms-full.txt` 全量文本，每页另有 `.md` 别名，可直接抓取核对，不必靠猜。

### 采纳清单

| 能力 | 上游 API | 落地位置 | 为什么算「可见」 |
| --- | --- | --- | --- |
| 流式耗时 | `useMessageTiming()` | `Chat.tsx` 的 `MessageTiming`，挂在消息动作栏末尾 | 助手消息下方出现「耗时 3.4s · 首字 620ms」，不必跳轨迹页 |
| 朗读回复 | `WebSpeechSynthesisAdapter` + `ActionBarPrimitive.Speak` / `StopSpeaking` | `voice.ts` 构造适配器，`Chat.tsx` 在助手侧按 `speech` 状态二选一挂载 | 助手消息多一个扬声器按钮，浏览器用系统语音读出来 |
| 语音听写 | `WebSpeechDictationAdapter` + `ComposerPrimitive.Dictate` / `StopDictation` | `voice.ts` + `ChatComposer.tsx` | 输入区多一个麦克风按钮，说完转成文字进输入框 |
| 输入历史召回 | `unstable_useComposerInputHistory()` | `ChatComposer.tsx`，`{...history}` 展开到 `ComposerPrimitive.Input` | 空输入框按 ↑ 召回上一条提问，↑ 继续往前、↓ 回到草稿 |

四项都**没有**新增任何后端字段：语音走浏览器 Web Speech API，耗时由运行时在客户端观测，历史从当前 thread 的用户消息派生（无持久化）。因此没有「界面声称支持、服务端其实没有」的语义错位。

### 耗时徽章的取舍（与项目「不伪造」原则直接冲突的一处）

`useMessageTiming()` 返回 `totalStreamTime` / `firstTokenTime` / `tokenCount` / `tokensPerSecond`，看上去可以直接全展示。但读源码后确认在 `useChatRuntime` 下不能这么做：

```ts
// @assistant-ui/core/dist/runtime/utils/streaming-timing.js
const defaultEstimateTokens = (textLength) => Math.ceil(textLength / 4);
...
...totalStreamTime > 0 && tokenCount > 0 && { tokensPerSecond: tokenCount / (totalStreamTime / 1e3) }
```

`useAISDKRuntime` 调 `useStreamingTiming(messages, isRunning)` 时**没有传 options**：

```ts
// @assistant-ui/ai-sdk/dist/runtime/useStreamingTiming.js
const useStreamingTiming = (messages, isRunning) =>
  useStreamingTiming$1(messages, isRunning, aiSdkStreamingTimingAccessors);
```

即 `tokenCount` 是**字符数 ÷ 4**，不是流里的 `usage`。把它标成 `tok/s` 等于把估算当测量发布，而且会和轨迹页上服务端权威数值打架。所以徽章**只显示两个浏览器真实观测到的时长**（`totalStreamTime`、`firstTokenTime`），并在 `title` 里写明「与轨迹页的服务端耗时不是同一来源」。这不是「少用了组件」，是有意不用该字段。

补充两点事实，写下来避免以后误判：`useMessageTiming` 读的是 `message.metadata.timing`（`MessageTiming` 类型字段，不是 `metadata.custom`）；timing 只在**本客户端看过**的那次流式结束时写入，服务端历史消息没有该字段，也不做回填。

#### 官方现成的 `MessageTiming` Elements 组件为什么没直接用

官方确有现成件（`/elements/message-timing`，固定提交 `3a45a0` 的 `elements/message-timing.aui.tsx`，104 行）：触发器是 `text-xs` 等宽按钮显示总时长，悬停浮层列出 First token / Total / Speed / Chunks。文档也明确推荐「把它放进 `ActionBarPrimitive.Root`，紧邻 Copy」，正是我们放徽章的位置。**没有采用它，理由只有一条**：它无条件渲染 Speed 行——

```tsx
{timing.tokensPerSecond !== undefined && (
  <div>…<span>Speed</span><span>{timing.tokensPerSecond.toFixed(1)} tok/s</span></div>
)}
```

而本运行时下 `tokensPerSecond` 恒有值且是「字符数 ÷ 4」（见上），所以这个组件会稳定地发布一个估算值并标上 `tok/s`。这与项目「不伪造、不估算」直接冲突，且与轨迹页的服务端权威 usage 会不一致。**这是本轮唯一一处「有现成件但不用」的取舍**，其余三项都用了上游组件。

两处附带成本也记下来，供将来若真要引入时估量：需要额外按源码引入 `ui/tooltip.tsx`（当前 `shared/assistant-ui/ui/` 只有 `button`/`collapsible`/`textarea`）并把它纳入 Tailwind 扫描面；静态变体（`message-timing.tsx`，props 驱动、`w-full max-w-sm flex-wrap` 的整行 stats）另需 `elements/surfaces.tsx` 的 `mono` 常量，且它是「整行页脚」版式，放进 22px 图标按钮组成的动作栏并不合身。

#### 关于真实 token 用量的边界

`@assistant-ui/ai-sdk` 另有 `getThreadMessageTokenUsage` / `useThreadTokenUsage`（`dist/usage.js`），从消息 `metadata.usage`、`metadata.custom.usage` 或 `metadata.steps[].usage` 里读**真实**用量，本身是诚实的。但它依赖 UI 流携带 usage，而本平台已核实 `toAISdkStream` 转 UI 流时会丢掉 `usage`（见 `docs/research/runtime-mastra-native-capabilities-2026-09-11.md`），因此这里会返回 `undefined`。要真正展示速率，缺的是**数据**（让运行时把真实 usage 带进 UI 流或单独提供），不是组件——这属于另一个课题，不在本轮。

### 语音按钮的门控为什么不交给组件

`ActionBarPrimitive.Speak` 看起来自带启用态，实际它只检查消息本身：

```ts
// @assistant-ui/core/dist/react/primitive-hooks/useActionBarSpeak.js
disabled = !((s.message.role !== "assistant" || s.message.status?.type !== "running") && s.message.parts.some((c) => c.type === "text" && c.text.length > 0));
```

**它不检查是否存在语音适配器**。所以浏览器没有 Web Speech API 时按钮照样可点、点了没反应。同理 `ComposerPrimitive.Dictate`。于是新增 `apps/console/src/features/chat/voice.ts`，把「支持性判断」与「适配器实例」放在同一处求值，按钮的门控条件就是「适配器存在」本身：

```ts
const speechAdapter = typeof window !== "undefined" && "speechSynthesis" in window
  ? new WebSpeechSynthesisAdapter() : undefined;
const dictationAdapter = WebSpeechDictationAdapter.isSupported()
  ? new WebSpeechDictationAdapter({ language: "zh-CN" }) : undefined;
export const readAloudSupported = speechAdapter !== undefined;
export const dictationSupported = dictationAdapter !== undefined;
```

适配器只在模块加载时构造一次（`useChatRuntime` 的 `adapters` 需要稳定身份），门控常量与它同源，因此不存在「门控说支持、适配器却缺失」的中间态。

### 输入历史与 `/` 快捷指令的共存

`unstable_useComposerInputHistory` 的 `onKeyDown` 首行就检查 `popoverCtx.getActiveAria() !== null` 时直接返回，即**弹窗打开时让位**；同时只在「空 draft + 光标首行 + 无选区 + 无修饰键 + 非 IME 组合」时才召回，所以多行编辑的 ↑/↓ 原生行为不变。这两点是它能和已有 `/` 指令菜单并存的原因，不是我们额外加的保护。

## 明确不采用

| 组件 | 不采用理由 |
| --- | --- |
| `ActionBarPrimitive.Edit` / `Reload` | 两者会触发运行时操作（`aui.message.reload()` 等）。本平台的会话消息、历史分支与 Run 是一对一持久化记录，重跑会产生新 Run；必须先定义消息身份与分支语义，不能只让界面看起来支持。 |
| `ComposerPrimitive.AddAttachment` / `Attachments` / `AttachmentDropzone` | `packages/contracts` 里没有任何附件字段，服务端也没有上传、存储与解析生命周期。组件本身可复用，但缺 AttachmentAdapter 就没有可接的目标，不先接一个假的上传路径。 |
| `ActionBarPrimitive.Feedback*` | 需要后端承接反馈存储与读取，平台没有对应契约。 |
| `ThreadPrimitive.Suggestions` / `SuggestionPrimitive` | 这是新增「推荐问题」功能，需要产品给出候选来源与文案，不属于减少自写代码；且已有 `/` 快捷指令覆盖「快速起手」的场景。 |
| 官方 `MessageTiming` Elements 组件（`elements/message-timing.aui.tsx`） | 它稳定渲染 Speed 行，而本运行时下 `tokensPerSecond` 是「字符数 ÷ 4」的估算值；同时需额外引入 `ui/tooltip.tsx`。详见上文。改为只展示两个真实观测时长的紧凑徽章。 |
| `useMessageTiming` 的 `tokenCount` / `tokensPerSecond` 字段 | 由字符数估算得出，非流内 `usage`，见上文。 |
| 轨迹页（`ConversationTrajectory` / `TrajectoryInspector`）复用 `ToolFallback` / `Reasoning` | 轨迹页渲染的是服务端事件投影（轮次分组、时长模式、分页、虚拟化窗口、来源标注），数据形状不是 AI SDK 的 message part。上一轮调研已结论：这些 part 组件不能替代平台服务端轨迹。 |

> `ActionBarPrimitive.Speak` / `StopSpeaking` 从第一版的「不采用」改为**已采纳**：Web Speech API 是纯浏览器能力，不需要平台契约，第一版把它和 `Feedback*` 归为一类是判断错误。


## 已核对的 API 事实

读安装包源码确认，用来避免把不存在的 API 写进实现：

- `ComposerPrimitive.If` 存在但已标 `@deprecated`，且只支持 `editing` / `dictation`，不支持 `running`；官方注释指向 `AuiIf condition={(s) => s.composer...}`。因此运行态分支继续用 `AuiIf`。
- `createActionButton`：`disabled = props.disabled || !callback`，`onClick = composeEventHandlers(props.onClick, callback)`。所以「回调为 null」表现为禁用而非卸载，且本地 `onClick` 与组件自身行为会同时生效。
- `actionBarReloadDisabled`：`thread.isRunning || thread.isDisabled || message.role !== "assistant"`。
- `trigger popover` 只在触发字符出现在输入框内时渲染 DOM，没有公开的「以编程方式打开」入口。因此「快捷指令 /」按钮把 `/` 写入输入框是既有官方机制的正确触发方式，不是绕过组件。
- `useActionBarSpeak` 的 `disabled` 只看消息（角色、`status.type === "running"`、有无文本 part），**不看是否配置了语音适配器**——见上文「语音按钮的门控」。
- `useActionBarStopSpeaking` 的 `disabled` 是 `message.speech == null`，与 `ActionBarPrimitive.StopSpeaking` 的挂载条件同源。
- `useChatRuntime` 的第 4 个选项 `adapters` 支持 `{ speech, dictation, suggestion, voice, feedback, attachments, history }`（`@assistant-ui/ai-sdk/dist/runtime/useChatThread.d.ts` 的 `ChatThreadOptions`）。
- `unstable_useComposerInputHistory()` 返回 `{ onKeyDown }`，仅此一项，直接展开到 `ComposerPrimitive.Input`。
- `getThreadMessageText`（`@assistant-ui/core/dist/utils/text.js`）是 `message.content` 里 text part 的拼接；输入历史的召回内容由它派生，因此持久化消息无需任何额外字段即可被召回。
- `ComposerPrimitive.Dictate` 的 `disabled` 是 `s.composer.dictation != null || !s.thread.capabilities.dictation || !s.composer.isEditing`——**它会检查 `capabilities.dictation`**，与 `ActionBarPrimitive.Speak` 不同。所以听写的门控严格说不是必需的，但保留它可以让按钮与适配器同源、避免两个判断将来漂移。
- 文档给出的听写结构与我们的实现一致：`AuiIf{composer.dictation == null} → Dictate` / `AuiIf{!= null} → StopDictation`（`/docs/guides/dictation` 的 `ComposerWithDictation` 示例原文）。朗读同理，文档明确写「加到 **assistant** 消息的动作栏」，与 `readAloud` prop 只传给 Assistant 侧一致。
- `WebSpeechDictationAdapter.isSupported()` 实际判断 `window.SpeechRecognition ?? window.webkitSpeechRecognition`（`@assistant-ui/core/dist/adapters/speech.js`）。Chrome/Edge/Safari 有（Chrome 走 `webkitSpeechRecognition`），Firefox 没有，因此麦克风按钮在 Firefox 下不渲染——这是本次门控的正确表现，不是缺陷。
- `@assistant-ui/ai-sdk` 导出 `getThreadMessageTokenUsage` / `useThreadTokenUsage`，读 `metadata.usage` / `metadata.custom.usage` / `metadata.steps[].usage` 的真实用量。

## 验证

`apps/console/tests/features/chat-assistant-ui.test.tsx` 4/4 通过，覆盖第三轮的可测部分：

1. 空输入框按 ↑ 依次召回两条历史提问，↓ 逐步回到最新并最终还原空草稿。
2. 有草稿时按 ↑ 不召回（`value` 不变），即不抢原生光标行为。
3. 环境缺 Web Speech API 时，朗读 / 停止朗读 / 语音输入 / 停止语音输入四个按钮**都不渲染**（前两行先断言环境确实缺该 API，使「不渲染」成为门控生效的证据而不是环境巧合）。
4. 流式回复后，页面文本里不出现 `tok/s`，即估算速率没有被展示出来。

`pnpm check` 全绿（lint / architecture:check / build / sdk:check / 后端测试 / 前端测试）。

**第三轮仍未做浏览器实机核验**，两条原因：

- 静默降级不可测：`readAloudSupported` / `dictationSupported` 在无头环境恒为 `false`，只能验证「不支持时不渲染」，验证不了「支持时调用的是系统语音」。
- 耗时徽章依赖 `isRunning` 的状态跃迁与毫秒级时间差（`totalStreamTime > 0` 才写入），在 jsdom 里跑出来的时长常为 0，因此断言只能是负向的（不出现估算速率），不能断言徽章一定出现。

需要在真机（Chrome/Safari）确认：

1. 助手消息出现扬声器按钮，点击后系统朗读该条回复，朗读中变成「停止朗读」按钮。
2. 输入区出现麦克风按钮，点击后浏览器请求麦克风权限，说话内容进入输入框。
3. 一次真实流式回复后，助手消息下方出现「耗时 x.xs · 首字 xxxms」，且**不含** `tok/s`。
4. 空输入框按 ↑ 召回的确实是上一条提问（jsdom 已验证逻辑，实机再确认与 IME 中文输入不冲突）。

此外第二轮遗留的布局核验（见上一节 5 项）同样未做。两者都属「浏览器实机确认」。

## 第二轮遗留的实机核验清单

以下依赖布局几何，jsdom 里不存在（`offsetHeight` 为 0、`mt-auto` 解析为 0，`contentInset` 恒为 0），所以测试通过**不能**证明重构正确。测试环境已 stub `ResizeObserver`（见 `apps/console/tests/helpers/dom.ts`），仅够让组件挂载不报错。

待实机确认：

1. Composer 常驻可见并贴在视口底部，内容在其下方滚动（`sticky` 与 `margin-top: auto` 的实际效果）。
2. 滚到底部时「回到底部」按钮消失（依赖 `contentInset` 上报正确）。
3. 空会话欢迎语垂直居中，且 Composer 仍在底部（未采用官方的空态居中变体）。
4. 错误 Alert 出现/消失时（footer 高度变化）滚动位置不异常跳动。
5. 窄屏 1150px / 600px 两档下内边距归属正确。
