# 模型管理：供应商、模型列表与能力声明

日期：2026-09-11。接续[接入体验改造](console-onboarding-ux-2026-09-11.md)。上一轮让模型**可验证、可修改**；这一轮解决**填得对不对、知不知道自己在接什么**。

## 原来卡在哪

上一轮之后，登记一个模型仍要求操作者从零掌握三件事：

1. **Base URL 的形态**。各厂商都把版本段塞在地址里，且互不相同——DeepSeek 是 `/v1`，智谱是 `/api/paas/v4`，百炼必须走 `/compatible-mode/v1`。填错要到探测时才暴露。
2. **模型 ID**。得从厂商文档抄，火山的接入点是 `ep-` 开头的 ID 而非模型名，抄错同样只能靠探测兜。
3. **模型到底能干什么**。`capabilities` 在平台里**完全不存在**。Agent 可以绑定任意工具，却能选一个不支持工具调用的模型，这个矛盾在发布时无人指出。

## 这一轮改了什么

### 供应商预设：把「地址形态」变成可选项

新增静态目录 `GET /api/v1/model-vendors`，每项含 `vendor` / `label` / `baseUrl` / `note`。

- **只收录 OpenAI 兼容面**。Runtime 只会说这一种协议，因此协议不同的厂商**不列**，而不是列出来再附一句「不可用」。
- **`baseUrl` 是 Runtime 实际拼接 `/chat/completions` 的前缀**，所以包含厂商要求的版本段。`custom` 的 `baseUrl` 为 `null`，表示需自行填写。
- **`note` 只记地址本身看不出的限制**，例如「火山方舟的模型 ID 需填接入点 ID」「百炼必须使用 compatible-mode 路径」「Ollama 本地服务通常无鉴权」。
- 这是**默认值而非白名单**：`custom` 接受任意兼容地址，任何预设都可被覆盖。选中带地址的预设才覆盖已填的 Base URL；`custom` 刻意不覆盖，以免清掉操作者手输的地址。

### 获取模型列表：从服务拿真实 ID

新增 `POST /projects/{id}/models/discovery`，请求服务自身的 `/models`。

- 复用与探测**同一套凭据解析**（提交的 key，或 `credentialFrom` 指向的已存凭据）。
- 区分五种结果，其中**两种不是失败**：
  - `unsupported`：服务响应了但没有目录接口（404/405），或响应不是 `data[].id` 形状。自建部署只提供 chat 很常见，因此这是部署属性，不是配置错误。
  - `rejected` / `unreachable` / `timeout`：与探测同义。
- 返回的 ID **去重排序**后给出，保证同一服务多次请求得到稳定列表。
- 界面用 `AutoComplete` 呈现：列举出的 ID 成为建议项，但**保留自由输入**。火山接入点 ID 一类不在列表里的值仍可手填——这一点在测试里被明确锁住。

### 能力声明：把「选了不该选的模型」提前暴露

`ModelInput` 增加 `vendor` 与 `capabilities`（`vision` / `toolUse`）。

- **声明而非探测**。平台不自动识别模型能力，也不据此改变请求方式；界面原文写明这点。
- **`vision` 当前仅作选型记录**。对话还不接受图片附件（`ChatComposer` 无附件通道），因此界面直接说明「不会让对话能够发送图片」，避免制造已支持的错觉。
- **`toolUse` 是实际生效的约束**。`Agents.validate` 在 `MODEL_TOOL_USE` 处拒绝「模型声明不支持工具调用，却绑定了工具或知识库」的组合——工具与知识库都经由工具调用到达，两者都算。检查读的是操作者自己的声明，**不会**去探测服务。Agent 编辑器同时就地给出同样原因的警告，让冲突在产生处可见，而不是只在保存失败后。
- **判断有误可以纠正**。错误文案指向模型设置，避免把声明变成无法挽回的锁死。

### 兼容既有数据

`Model` 由 `ModelInput.omit({ apiKey: true })` 派生，行数据按输入载荷存储、每次读取都重新解析，因此新增字段必须能容纳**旧行**。

这里有一个 zod 4 的陷阱：`ModelCapabilities.default({})` 在 `.strict()` 对象上会**短路内层默认值**，旧行解析出的 `capabilities` 是 `{}`，而它自身的 schema 要求 `vision`/`toolUse` 必填——于是旧行直接解析失败。改用 `.prefault({})`：先补全对象再解析，旧行得到 `{ vision: false, toolUse: true }`。契约测试专门锁这条路径。

## 明确没做

- **凭 vendor 改变请求方式**。`vendor` 目前只用于展示与预填；鉴权、路径、参数仍按 OpenAI 兼容处理。若将来接入非兼容协议，需要真正的适配层，而不是往这个枚举里加值。
- **由 Runtime 执行探测与列表**。与上一轮相同的局限：控制面对私有网络模型只能给出 `unreachable`。界面上如实标注。
- **SSRF 未完全消除**。列表与探测的 URL 都由项目成员提供，同样只受 `requireUser` + `checkUrl` 约束。
- **探测/列表不进运行轨迹**。它们是接入期动作，不写 `run_events`。

## 验收

- 契约：`tests/contracts/model-capabilities.test.ts`（旧行解析、部分声明、未知 key 拒绝、未知 vendor 拒绝）。
- 集成：`tests/integration/integration.test.ts` 覆盖列表的 `ok` / `unsupported` / `rejected` / `unreachable`、目录内容、vendor 与 capabilities 往返，以及 `MODEL_TOOL_USE` 拒绝与「不绑任何工具时同一模型可通过」。
- 前端：`apps/console/tests/features/editors.test.tsx` 覆盖预设预填与提示、声明能力随保存提交、列表成为建议项且保留自由输入、`unsupported` 文案、目录失败不阻塞登记、Agent 编辑器的不支持工具警告。
