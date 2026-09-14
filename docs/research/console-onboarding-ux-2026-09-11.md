# 接入体验：新建对话与新建模型

日期：2026-09-11。接续[轨迹采集 P0](trajectory-collection-p0-2026-09-11.md)。本轮只改**接入路径**，不改轨迹读取。

## 原来卡在哪

排查了真实代码路径，两处都不是样式问题：

**新建对话。** 对话页侧栏的 `+`（`aria-label="新建会话"`）绑定的是 `onCreate={() => go("agents")}`。点一下会把人送到 Agents 页面，既不解释原因也不保留上下文，用户得自己在 Agent 卡片上再找「对话」入口。空态按钮文案写成「选择 Agent」比较诚实，但行为仍是跳页。

**新建模型。** 表单要求填名称、能力、Base URL、模型 ID、API Key，却**没有任何验证途径**；界面上唯一的说明是「对话模型通过 Agent 验证」——意思是填错了要等到很久以后某次运行失败才知道。而且接口只有 `listModels` / `createModel`，登记错了**既不能改也不能删**。

## 这一轮改了什么

### 新建对话就地完成

`ChatWorkspace` 自己持有选择器：点击后弹出已发布 Agent 列表，选中即创建会话并直接进入，全程不离开对话页。

- 只列出 `publishedReleaseId` 非空的 Agent。会话必须固定到发布版本，草稿 Agent 无法承载对话，所以**不展示**，而不是展示后再报错。
- 没有可用 Agent 时，弹窗说明「对话必须绑定一个已发布的 Agent」，并给出「前往 Agents」按钮。跳转仍然存在，但变成用户的显式选择，而不是按钮的隐藏副作用。

### 模型可以先验证再存盘，也可以事后修改

- **测试连接**。`ModelEditor` 增加探测按钮，调用新增的 `POST /models/probe`。探测由控制面按 **Runtime 实际使用的方式**发起（`baseUrl` + `/chat/completions`｜`/embeddings`｜`/rerank`，同样的 `Bearer` 头），只发一句 “ping”，不写任何数据。
- **区分两种失败**——这是本轮最要紧的一处。`outcome` 分 `ok` / `rejected` / `unreachable` / `timeout`：
  - `rejected`：服务真的响应了，但状态码或响应形状不对，界面附上服务端**原样返回的消息**；
  - `unreachable` / `timeout`：**平台侧**连不上，界面明确写出「这不代表 Runtime 不可达」，避免把网络位置问题误报成配置错误。
- **不止看 200**。对话要求 `choices`、向量要求 `data[].embedding`、重排要求 `results`；配置了向量维度时还会比对服务实际返回的宽度。
- **凭据复用**。编辑时留空 API Key 表示保留已存凭据；探测也支持用 `credentialFrom` 复用，浏览器始终拿不到明文密钥。
- **可编辑**。新增 `PATCH /models/{id}`，列表增加「编辑」操作。表单写明「已发布的版本固定了原有配置，这里的修改只影响之后重新发布的 Agent」，避免误以为会影响正在跑的版本。
- **把填错点摊开**。Base URL 下方实时显示实际调用地址，直接说明服务商文档里的版本路径（如 `/v1`）要不要包含在 Base URL 里。

顺带在 `checkUrl` 加了云实例元数据地址拦截（`169.254.169.254` 等），因为探测让控制面成了发起方。

## 明确没做

- **删除模型**。需要「是否仍被 Agent 引用」的判定，否则会留下指向已删模型的 Agent；留给另一轮。
- **由 Runtime 执行探测**。控制面探测对私有网络模型会给出 `unreachable`。架构上更正确的是像 MCP 发现那样由 Runtime 代跑，但那需要一整套作业队列与回传契约；本轮没做，界面上如实标注了这个局限。
- **探测不进运行轨迹**。它是接入期动作，不是 Agent 运行，因此不写 `run_events`。
- **SSRF 未完全消除**。探测 URL 由项目成员提供，受 `requireUser` + `checkUrl`（拒绝带凭据／查询参数／片段，拒绝元数据地址）约束。这不等于完整的出网白名单。
- **未做浏览器实测**。界面验收来自 jsdom 回归，没有跑真实浏览器。

## 验收

新增 `apps/console/tests/features/conversation-picker.test.tsx`（2/2）：从对话页打开选择器、只展示已发布 Agent、选中后创建会话并进入 `/chat/<id>`；目录为空时**停在原页面**并说明原因，点「前往 Agents」才跳转。

扩展 `apps/console/tests/features/editors.test.tsx`（5/5）：探测结果展示服务端原话与实测事实（`HTTP 401 · 用时 14 ms`），未填写 apiKey 时不发送该字段；`unreachable` 的说明包含「不要据此判断模型配置有误」；编辑预填原值、发出 `PATCH`、留空 Key 时不发送 `apiKey`。

扩展 `tests/integration/integration.test.ts`：探测的 `ok` / `rejected`（校验服务端消息被原样带出）/ `unreachable`、向量维度匹配与不匹配、凭据复用，以及 `PATCH` 后凭据仍在。

夹具 `tests/fixtures/model-fixture.ts` 增加 `/v1/embeddings` 与 `/v1/rerank`；向量固定返回 8 维（真实服务的宽度是固定的），因此可以把「配置 1024 维」判成不匹配。

检查：`pnpm check` 通过（lint → architecture:check → build → sdk:check → 后端 → 前端）。后端 52 项、50 通过、2 跳过（需要专用镜像的 Docker 沙箱项）；前端 54 项全通过。生产构建仍有此前的大 chunk 提示。

## 一个实现坑

`Form.useWatch` 首次返回 `undefined`，真实值要等下一次渲染才到。原先用 `useEffect(() => setProbe(idle), [watch...])` 在字段变化时清空探测结果，结果探测完成的那一刻正好撞上 watch 从 `undefined` 变成真实值，**刚拿到的结论立刻被自己的 effect 清掉**（现象是：请求发出去了、响应也回来了，界面上什么都没有）。

改为把「探测时实际用到的值」拼成签名随结果一起保存，渲染时比对签名，彻底去掉这个 effect。
