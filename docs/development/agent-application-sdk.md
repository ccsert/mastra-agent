# Agent 应用接入指南 · 协议 1.0 / SDK 0.1

## 已实现范围

平台任务台通过 `platform_app` 使用同一套语义动作协议操作内置平台和独立应用。第三方无需采用平台组件，不需要 React。第一阶段提供可见 iframe 集成和框架无关 JavaScript SDK；页面切换、检索、表单草稿、校验和自定义非持久化动作均可由应用登记。

平台本身提供 `page.navigate`、`agent.create`、`agent.draft.patch`、`page.control`。旧 `platform_ui` 仅作为旧会话兼容；两个通道互斥。

## 一个已有系统如何接入

以下按 2026-09-14 当前代码整理。接入需要应用方修改前端，主动提供状态与业务动作；应用可继续使用原有 React、Vue、原生 JavaScript 和组件库。平台目前通过右侧抽屉中的 iframe 连接应用，尚不能接管用户另外打开的浏览器标签页。

| 步骤 | 负责人 | 需要完成的工作 | 交付结果 |
| --- | --- | --- | --- |
| 1. 确定首批场景 | 应用产品、开发 | 选择一个完整流程，例如查找订单 → 打开详情 → 填写备注 → 检查草稿；明确哪些数据可供助手读取、哪些动作可执行 | 动作清单、数据范围和权限要求 |
| 2. 准备协作入口 | 应用前端、运维 | 提供可嵌入的独立 origin 页面，验证应用自身登录在 iframe 内可用，配置精确的平台来源 | 页面 URL、宿主 origin、嵌入策略 |
| 3. 引入 SDK | 应用前端、平台开发 | 集成 `@platform/agent-ui`；当前为仓库 workspace 包，跨仓库使用前需安排内部包分发及 `@platform/contracts` 依赖 | 固定版本的 SDK 与依赖 |
| 4. 声明能力清单 | 应用开发 | 为每个业务动作填写 ID、说明、影响分类和输入/输出 JSON Schema；清单与页面实际实现保持一致 | `manifest.json` |
| 5. 实现状态与动作 | 应用前端、业务开发 | 实现 `observe()` 和对应 handlers，复用手动操作的状态更新、路由和校验逻辑；执行前再次检查当前应用用户的权限 | 可读取状态、能真实改变页面的动作适配层 |
| 6. 加入授权与反馈 | 应用前端 | 安装 `serveAgentApplication`，提供读取/视图授权、独立草稿授权、正在操作的提示和停止按钮；退出登录或撤销授权时停止连接 | 可授权、可见、可停止的协作界面 |
| 7. 在平台登记 | 项目管理员 | 在平台助手任务台中登记 `{ url, manifest }`，并确认项目已配置支持工具调用的助手模型 | 项目内可选择的协作应用 |
| 8. 联调并验收 | 双方开发、测试 | 用普通用户和实际访问地址验证状态读取、页面动作、草稿授权、人工修改冲突、停止、断线和结果回执 | 可复现的验收记录 |

应用方最少需要交付：一个可嵌入的页面地址、一份能力清单、一组 `observe`/handler 实现、授权与操作提示，以及对应部署配置。接入本身不要求新建业务后端；若原系统缺少权限校验、必要查询或校验能力，应在应用自己的业务层补齐。

## 如何设计首批动作

以订单系统为例：

| 动作 | 分类 | 预期行为 |
| --- | --- | --- |
| `orders.read` | `read` | 返回当前用户可读取的订单信息，不改变页面 |
| `orders.search` | `view` | 根据条件筛选列表，页面展示实际筛选结果 |
| `orders.open` | `view` | 打开指定订单详情，并处理已有未保存草稿 |
| `orders.draft.patch` | `draft` | 填写备注、优先级等允许的字段，保持未保存状态 |
| `orders.draft.validate` | `view` | 执行本地校验，在页面展示问题和反馈 |

动作应表达业务目的，例如“填写订单草稿”。通用组件适配可在应用内部复用；当前平台尚未提供 React/Vue/Ant Design 的通用适配包。

`observe()` 返回当前页面、加载是否完成、允许公开的业务状态、摘要，以及当前可用的动作。加载中应设置 `ready=false`；权限不足、没有选中记录或存在未保存冲突时，将对应动作设为不可用并说明原因。仅向平台提供任务需要的数据，这些状态、参数与结果会进入会话及轨迹。

handler 必须更新应用真实状态，并等到结果可由 `observe()` 核对后才返回成功。SDK 负责校验参数、页面修订和幂等请求，但不会替应用实现业务权限、字段校验、路由或数据加载。一个 SDK 实例应覆盖当前协作页面生命周期，普通组件重渲染时不应反复创建实例。

当前 manifest 最多 40 个动作，单份状态/动作参数/输出对象的序列化内容上限为 24000 字符；按需提供当前任务所需的信息，避免输出整个应用的数据。

## 部署前需要核对的配置

| 配置 | 应用方需要确认的内容 |
| --- | --- |
| 应用 URL | 当前登记校验要求 HTTPS，仅允许 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP 例外；普通局域网 IP 的 HTTP 应用地址目前不能登记 |
| 平台 origin | `serveAgentApplication.hostOrigin` 必须等于浏览器实际打开的平台 origin，包含协议、主机和端口，不含路径；多环境应从应用自身可信配置中选择 |
| 双方来源 | 应用 iframe 必须与平台不同 origin；允许嵌入与允许协作通信是两项配置，均需核对 |
| 嵌入策略 | 应用响应头中的 CSP `frame-ancestors` 应允许精确的平台地址；若平台自身设置了 CSP，也需允许加载该应用 iframe |
| 登录状态 | 第三方保持自己的登录和权限；平台不会把登录凭据传入应用。实际验证浏览器的跨站 Cookie、SSO 与 iframe 限制 |
| 当前 sandbox | 平台仅开放 `allow-scripts allow-same-origin`；依赖原生表单提交、弹窗、顶层跳转或下载的流程需要另行评估，不能假设已获支持 |

`frame-ancestors` 必须通过 HTTP 响应头配置；跨站嵌入还可能受第三方 Cookie 策略影响。参考 [MDN 嵌入来源配置](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)、[第三方 Cookie](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies)。消息通信用精确 `origin` 和 `source` 校验，参考 [MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)。

本次 Northstar 示例的已知问题：页面默认只接受 `http://127.0.0.1:5179`，可选宿主列表也仅包含 loopback 地址。通过 `http://192.168.110.151:5179` 使用平台时，需要同时补齐示例的可信宿主配置与宿主选择；仅填写 `hostOrigin` 查询参数仍会被现有白名单拒绝。这个限制尚未在示例代码中修复。应用 URL 中的 `127.0.0.1` 始终指用户浏览器所在机器，不能作为其他电脑访问服务器上应用的地址。

## 每次使用与权限关系

用户操作顺序为：打开平台助手 → 选择已登记应用 → 在右侧应用完成自身登录并允许协作 → 按需在两侧允许未保存草稿 → 连接当前页面 → 向助手描述任务。

有效权限取平台用户权限、第三方当前登录用户权限、本次用户授权，以及页面当前可用动作的交集。当前没有把平台账号自动映射为第三方账号的机制；第三方必须根据自己的会话检查用户权限。

平台登记/移除应用要求 `resource.manage`，使用第三方应用要求 `resource.read`，修改第三方草稿还要求 `resource.edit`。应用侧的 `authorize` 和 handler 仍需检查第三方权限。平台勾选允许草稿不会自动替应用侧授权。

平台助手已有 `platform_app` 工具，通过 `inspect → describe → act → result` 读取页面、了解动作、发起操作和查询结果。采用现有 SDK 接入时，应用方提供 manifest 和 handlers 即可，不需要为每个按钮在平台上单独新增工具。

## 联调验收与错误定位

| 验收场景 | 应确认的结果 |
| --- | --- |
| 精确来源、清单一致并已授权 | 连接成功，助手读取到实际页面和当前可用动作 |
| 查询、详情、草稿和校验 | 页面出现真实变化，回执与最终状态一致，草稿仍未保存 |
| 权限不足或未授权 | 不可执行对应动作，不能因平台账号权限较高而越过应用权限 |
| 用户手动修改后执行旧动作 | 返回 `STALE_REVISION`，重新读取页面后才能继续 |
| 相同请求重复到达 | 同一页面实例内不重复执行，返回已记录的回执 |
| 停止、关闭抽屉、刷新或隐藏页面 | 原连接失效，重连由用户发起；已开始动作的结果不确定时保留 `unknown` |
| 错误来源、清单版本变化、页面未加载 | 不能建立有效连接；检查具体阶段，而非反复重试动作 |
| 真实部署环境 | 使用最终 HTTPS 地址或实际开发入口验证，不能仅在 localhost 验收 |

当前连接/读取回执等待上限为 5 秒，跨域动作回执为 20 秒。超时只能说明没有拿到有效回执，不能单凭提示判定“应用不支持”或“操作没有发生”。先核对 iframe 是否正常加载、SDK 是否初始化、平台 origin 是否匹配、两侧授权、manifest 是否一致；执行中超时需核对页面实际状态，不能自动重放。

## 运行示例

在仓库根目录执行：

```sh
pnpm install
pnpm db:migrate
pnpm --filter @platform/contracts build
pnpm --filter @platform/agent-ui build
pnpm --filter @platform/agent-ui-example dev
```

平台通常由 `pnpm dev` 启动。示例独立运行于 `http://127.0.0.1:5181/`，仅使用原生 DOM 与 JavaScript；不使用 React、Ant Design 或平台的字段封装。

1. 打开示例的“开发者接入配置”，复制 JSON，或下载 `registration.json`。
2. 管理员在平台助手新任务 → 应用协作 → 接入应用中登记配置。
3. 选择 Northstar 订单工作台，主工作区显示独立页面，右侧保留助手。先在应用内勾选允许协作，再在任务台连接当前页面。
4. 默认仅允许读取及视图操作。需要填写时，两侧显式允许未保存草稿，且当前平台角色需要 `resource.edit`；内置 Agent 草稿使用 `agent.edit`。
5. 输入：“搜索星河，打开 ORD-1002，把交付备注改成合成验收，优先级设为紧急，再检查草稿。”
6. 验证页面筛选、详情、字段与校验实际变化，工具卡片显示成功回执且 `persistence=not-requested`。
7. 在任一侧停止、关闭应用工作区、切换浏览器标签或刷新页面，原授权失效。重新连接必须由用户发起。

示例仅允许宿主 origin `http://127.0.0.1:5179` 或 `http://localhost:5179`。后者需把登记 URL 改为 `http://127.0.0.1:5181/?hostOrigin=http%3A%2F%2Flocalhost%3A5179`。生产接入必须把允许宿主列表改为实际、精确的 HTTPS origin，不可直接信任查询参数。

## 应用实现

```js
import { createAgentApplication, serveAgentApplication } from "@platform/agent-ui";

const application = createAgentApplication({
  manifest,
  observe() {
    return {
      page: { id: "orders.detail", title: "订单详情" },
      ready: !loading,
      summary: "正在编辑订单草稿，尚未保存",
      state: { orderId, draft: { note } },
      actions: [{ id: "orders.draft.patch", available: canEdit && !loading }],
    };
  },
  handlers: {
    "orders.draft.patch": async (args, { signal }) => {
      signal.throwIfAborted();
      // 与手动操作共用应用自己的业务逻辑；再次检查权限、目标与未保存状态。
      await updateVisibleDraft(args, signal);
      signal.throwIfAborted();
      return { output: { message: "草稿已更新" }, message: "草稿已更新，尚未保存" };
    },
  },
  onStatus({ running, title }) {
    // 必须让用户看到正在操作哪个页面，并提供停止入口。
    renderActivityIndicator(running, title);
  },
});

const bridge = serveAgentApplication({
  application,
  hostWindow: window.parent,
  hostOrigin: "https://platform.example",
  authorize: (allowDraft) => signedIn && userGrantedView && (!allowDraft || userGrantedDraft),
});
// 用户停止、退出登录或撤销授权时调用：
stopButton.onclick = () => bridge.stop();
// 页面卸载或集成销毁时调用 bridge.dispose()。
```

完整 manifest 格式参考 `apps/agent-ui-example/src/manifest.json`。manifest 与 handlers 要一一对应；每个动作使用稳定业务名称、用途、影响分类、输入/输出 JSON Schema。平台只在 `describe` 时提供完整 schema，避免每轮携带整个组件树。当前支持有限的对象型 JSON Schema，不支持远程引用、正则、异步校验、格式扩展或隐式类型转换。

## 契约与执行语义

- `observe` 仅提供应用主动允许的可见状态。不要发送密码、令牌、隐藏权限配置或整棵 DOM；这些数据与动作参数会进入平台会话及轨迹。
- 每个 SDK 实例生成独立 `pageSessionId`，状态变化生成新 `revision`。`expectedRevision` 不一致时拒绝执行，用户手工修改优先。
- 服务端基于当前用户及项目权限、当前运行有效性、任务归属、应用登记、窗口和页面实例校验每次请求。平台账号权限不能替代第三方自己的权限校验。
- 应用登记由项目管理员完成；manifest 必须在握手中完全一致。变更能力需移除旧登记并重新登记，现有连接撤销。登记不等于用户已授权某次任务。
- `requestId` 是服务端动作 ID。SDK 对同一 ID 返回同一 Promise/回执；ID 与参数冲突报错。每个页面实例最多 2000 个请求，达到上限需刷新创建新实例，不能淘汰旧 ID 后重新执行。
- `pending` 表示排队，`executing` 表示已交给页面。只有 `succeeded`、`uiApplied=true` 和有效输出证明 SDK handler 完成；`persistence=not-requested` 明确表示未请求保存。
- 已开始后异常、超时、断连、取消或输出不合规，按 `unknown` 处理。页面可能已部分改变，助手须重新读取核对，不能自动重放。未开始就失联的动作标记 `cancelled`。
- 平台与页面均使用 8 秒连接租约；平台心跳约 650ms，与动作执行独立。SDK 跨域动作等待上限 20 秒，服务端动作上限 25 秒。长操作应分成可核对的小步骤。
- 单个会话仅连接一个页面，最多一个动作执行。切换应用要先停止；关闭抽屉、隐藏文档、刷新和停止都会撤销连接。
- 通信校验精确 origin、Window source 与随机 channel。第三方 iframe 禁止与平台同源部署，并使用 sandbox；不提供 top-navigation、弹窗或下载授权。平台凭据不会通过 bridge 传给第三方。
- 页面必须允许被指定宿主嵌入，例如配置精确 `frame-ancestors`。不允许嵌入的第三方应用暂不能使用此 transport。
- 业务 handler 必须遵守 AbortSignal，不可在停止后继续发起新动作。协议无法回滚已产生的副作用，也无法强制中止不合作的第三方代码；因此回执保留 unknown，不能把它解释成失败且未发生变化。

## 尚未实现

业务保存、发布、删除和对外提交需要独立的审阅/授权协议；此版不会把这些动作作为草稿绕过审批。原生 WebMCP、浏览器扩展/独立标签页 transport、未接入应用的视觉自动化、第三方 OAuth 委托、分页动作发现和通用组件适配包属于后续阶段。SDK 尚未发布 npm 包，不宣称可直接控制任意现有网站。
