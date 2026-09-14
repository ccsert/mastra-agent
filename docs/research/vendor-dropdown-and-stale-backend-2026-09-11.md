# 供应商列表为空 / 模型列表报错（2026-09-11）

## 现象

控制台上两处同时失效：

1. 模型编辑器的「供应商」下拉为空，没有任何可选项。
2. 「获取模型列表」报「列表请求未发出」，详情为「无法连接平台服务」。

## 根因

**运行中的控制面进程是旧代码。** 前端由 Vite 提供，源码一改通过 HMR 立刻生效，
所以新界面（供应商下拉、测试调用按钮）都显示出来了；而 `scripts/dev.ts` 用
`tsx` **直跑**控制面、没有 watch，进程仍是改动前启动的那一份。

证据（都是实测，不是推断）：

- 运行中的控制面 `GET /openapi.json` 只有 **57** 条 paths，仓库生成的版本有 **63** 条。
  差集正好是这两轮新增的全部接口：

  ```
  /api/v1/model-vendors
  /api/v1/projects/{projectId}/models/discovery
  /api/v1/projects/{projectId}/models/probe
  /api/v1/projects/{projectId}/models/{id}
  /api/v1/projects/{projectId}/tools/probe
  /api/v1/projects/{projectId}/tools/{id}
  ```

- 用**当前代码**另起一份控制面（备用端口）验证：63 条 paths，且与
  `packages/contracts/openapi/platform.json` **完全一致**。即新代码本身没有问题。

- 请求日志给出决定性判据：新代码上 `/api/v1/model-vendors` 是 `route: "/api/v1/model-vendors"`
  （**matched**），而未知路由是 `route: "unmatched"`。旧进程上它走的是 unmatched 分支。

请求打到不存在的路由时，Hono 返回**纯文本** `404 Not Found`（`content-type: text/plain`），
不是平台的 `{code,message}` 形状。SDK 客户端对非 JSON 响应体执行 `throw textError`，
于是 `unwrap` 拿到的是一个**字符串**——而旧实现只在 `error` 是对象且有 `message` 时取用，
否则一律回落成「无法连接平台服务」。「后端版本旧」被说成了「网络不通」。

## 修复

### 1. 控制面热重载（消除版本错位的成因）

`scripts/dev.ts` 给控制面加 `--watch`：

```
node --conditions=development --watch --import tsx apps/control-plane/src/main.ts
```

用 node 自带的 `--watch` 而不是 `tsx watch`，因为后者会丢掉
`--conditions=development`（该条件决定工作区包解析到 `src/*.ts` 还是 `dist`，
前端也因此不再出现「后端落后一版」的错位。

实测：改动 `vendors.ts` 后日志出现 `Restarting` → 优雅 `stopping/stopped` → 重新 `started`；
用备用端口跑 `scripts/dev.ts` 三端全部起来，控制面 paths 为 63。

### 2. 错误文案按真实原因区分（`apps/console/src/shared/api.ts`）

`unwrap` 有 **68 个调用点却零测试覆盖**，这正是错误文案长期没被发现的原因。
新增 `failureMessage(error, response)`，分支顺序按「信息具体程度」排：

1. **无响应**（`response` 为 undefined）→「无法连接平台服务，请确认服务已启动。」
   必须排在最前：传输层的 `TypeError` 也带 `.message`，否则会把 `fetch failed` 原文显示出来。
   （这一条是补测试时抓出来的真实缺陷。）
2. **有 `{message}` 的错误体** → 用服务端原文（最具体，且既有测试断言了 503 时的服务端文案）。
3. **404** →「平台没有这个接口（404）。后端可能还没更新到当前代码，请重启服务后重试。」
4. **5xx 且无错误体** →「平台服务出错（HTTP 502），请查看服务日志。」
5. 其余 → 字符串错误体或 `请求失败（HTTP xxx）`。

### 3. 供应商列表失败可见且可重试（`ModelEditor`）

原来失败只塞进字段的 `extra`，下拉是空的——「读不到目录」看起来和「没有供应商」一样。
改为独立的 warning Alert，含服务端原因与「重新获取」按钮，并说明该列表只是预填便利、
**不影响保存**。

### 4. 措辞不再预设原因

「列表请求未发出」「探测请求未发出」在 404 时是错的：请求发出去了，是后端没有该路由。
改为「没能获取模型列表」「没能完成测试调用」，原因交给详情说明。

## 测试

- `apps/console/tests/features/api-failure.test.tsx`（新增 6 项）：服务端 `{message}`、
  5xx 保留服务端原文、404 明确说没有该接口且**不出现**「无法连接平台服务」、
  无响应才说连不上、无错误体的 5xx 带状态码、成功与分页游标。
- `apps/console/tests/features/editors.test.tsx`：改写「失败目录不阻塞登记」为
  「可见 + 可重试 + 说明不影响保存」；新增 404 用例断言不误报为网络故障。

控制台测试 72/72 通过（原 65 项 + 新增 7 项）。

## 未实施 / 遗留

- `scripts/dev.ts` 的 Runtime 仍是直跑（无 watch）。Runtime 改动同样需要手动重启，
  本轮只修了导致本次问题的那一半。
- 上面第 3、4 项之外的其它 `unwrap` 调用点文案未逐一复核，只保证了分支判据统一。
- 未在真实浏览器中复验（本轮的验证都在 HTTP 与测试层）。
