# 工具管理：可编辑与可验证（2026-09-11）

## 背景

上一轮把模型管理做成了「可选供应商、可拉取模型列表、可声明能力、可编辑、可测试连接」。
工具管理停留在更早的形态，与模型形成明显的不对称：

| | 模型 | 工具（改动前） |
| --- | --- | --- |
| 编辑 | `PATCH /models/{id}` + 编辑器预填 | 无接口，编辑器只新建 |
| 登记后验证 | `POST /models/probe` | 无。只能等 Agent 运行时才发现填错 |
| 列表操作列 | 「编辑」 | 无 |

`http_get` 工具的失败面比模型更大：地址、查询参数拼法、输出 JSON Schema 三者任一不对，
都要等一次真实运行才暴露。因此本轮补齐「编辑」与「测试调用」。

## 已验证的实现

### 契约（`packages/contracts/src/tools.ts`）

- 新增 `AuthoredToolKind`（`sum` / `http_get`），把「人可以手写登记的两种」与
  `Tool.kind` 的三种（含 `mcp`）分开。`mcp` 工具是远端描述符的固定投影，由导入流程产出，
  不由人填写，因此 `ToolInput` 与探测输入都不接受它。
- `ToolUpdate = ToolInput.extend({ bearerToken: Credential.optional() })`：留空或省略表示
  保留已存凭据；凭据从不回显。
- `ToolProbeInput`：`kind` / `url` / `bearerToken?` / `credentialFrom?` / `inputSchema` /
  `outputSchema` / `input`（样例参数，`prefault` 为 `{}`）。
- `ToolProbe`：`outcome`、`httpStatus`、`latencyMs`、`message`、`requestUrl`、`preview`。
- `outcome` 的取值各自对应一种修法，刻意不合并成一个「失败」：
  - `invalid` —— 样例参数不符合输入 schema，**没有发出请求**。这是操作者自己的输入错误。
  - `rejected` —— 服务拒绝（非 2xx），或 2xx 但不是 JSON。连不上协议。
  - `mismatch` —— 服务返回 200 且是 JSON，但不符合声明的输出 schema。
    **只有这一种是靠改 schema 修的**，与 `rejected` 混在一起会让人找错方向。
  - `unreachable` / `timeout` —— 平台侧网络问题，不是对工具的判断。

### 控制面

- `transport.ts`：`requestBounded` 增加 `timeoutMs`，`transportMessage` 按实际超时措辞。
  新增 `TOOL_TIMEOUT_MS = 10000`，与 Runtime 调用工具的超时一致 —— 探测若允许更长，
  会对一次真实运行中必然超时的调用报「ok」。
- 新增 `tool-probe.ts`：按 `apps/runtime/src/tools/execute.ts` 的真实方式复现调用。
  - `sum`：本地求值（Runtime 也是本地求值），不发请求，`httpStatus`/`latencyMs` 为 null。
  - `http_get`：样例参数按 Runtime 的规则拼进查询参数（字符串直传，其余 `JSON.stringify`），
    GET，`redirect: error`，带 Bearer，要求 JSON，再用 `outputSchema` 校验。
  - 探测前先用 `inputSchema` 校验样例参数，不合格就返回 `invalid` 且不发请求。
- `resources.ts`：
  - 抽出 `authoredTool()`，create 与 update 共用，保证「登记后不会被编辑成跑不通的形态」。
  - `resolveKey` 泛化为接受 `kind: "model" | "tool"` 与显式传入的凭据/`credentialFrom`，
    模型 token 与工具 token 不会走错路径。
  - `updateTool`：MCP 工具抛 409 `MCP_TOOL_IMMUTABLE`。
  - `probeTool`：`http_get` 走 `checkUrl` 同款校验（含实例元数据地址拒绝）。
- 路由：`PATCH /api/v1/projects/{projectId}/tools/{id}`（`updateTool`）、
  `POST /api/v1/projects/{projectId}/tools/probe`（`probeTool`）。

### 控制台

- `ToolEditor`：支持编辑（预填 + `PATCH`，执行方式在编辑时不可改，因为协议已定）；
  「测试调用」按钮与「样例参数」字段；`sum` 与 `http_get` 各给一段可运行的样例；
  JSON Schema 在前端先做 `JSON.parse` 校验，错误本地化且具体。
  结果区展示平台实际请求的 URL 与返回内容（bounded），`mismatch` 额外提示「要改的是 schema」，
  `unreachable`/`timeout` 额外提示「这只说明平台侧网络不通」。
- `ToolWorkspace`：新增「执行方式」「接口地址」「凭据」列与操作列。
  MCP 工具显示「不可编辑」并说明原因，而不是看起来坏掉。
- `EditorHost` / `EditorResource` / `ProjectConsole` / `ProjectPage`：`tool` 资源贯通，
  `openEditor("tool", tool)` 表示编辑。

## 测试

- `tests/contracts/tool-management.test.ts`（6 项）：旧行解析、MCP 描述符、update 可选 token、
  手写登记拒绝 `mcp`、探测输入默认 `{}`、未知键拒绝。
- `tests/integration/tool-management.test.ts`（4 项）：真实 HTTP 夹具下
  成功 / `mismatch` / 非 JSON / `invalid` 不发请求 / 401 带服务原文 / 不可达；
  `sum` 不发请求；编辑保留空白凭据且坏 schema 被拒后原值不变；MCP 不可编辑、
  且探测不接受 `mcp` kind（400）。
- `apps/console/tests/features/tool-editor.test.tsx`（6 项）：编辑 PATCH 且不带 token、
  探测展示实际请求 URL、`sum` 不发请求且不声称有地址、不可达措辞、
  非法 JSON 本地拒绝（零请求）、列表只对可编辑工具给操作。

## 未实施

- 工具删除。需要「是否仍被 Agent 引用」的判定，与模型删除同一类问题，留待后续。
- 由 Runtime 代跑探测。控制面探测能覆盖当前所有工具类型；MCP 工具需要活跃绑定，
  只能由 Runtime 代跑，目前以 400 明确拒绝而非假装支持。
