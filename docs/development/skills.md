# 标准 Skills 接入与执行

本轮将已有隔离原型接入正式控制面、Runtime、生成 SDK 和控制台。保留纯 Agent、知识库与工作流；工作流的 Agent 节点复用该 Agent 发布版本中的 Skills。

## 使用

1. 在项目的 **Skills** 页面导入标准 ZIP。可使用 [订单汇总样例](../../examples/skills/order-summary.zip)，源目录同时保存在仓库中。
2. 查看版本中的 `SKILL.md`、参考资料和脚本。导入成功表示格式及平台包限制通过；不会自动授予脚本或业务工具权限。
3. 编辑 Agent，在 **Skills** 中选择固定版本。读取指令和包内资料随绑定授权；需要执行脚本时，勾选具体入口，再保存和发布。
4. 在新会话请求：“请用 order-summary 汇总合成订单 DEMO-001 金额 40、DEMO-002 金额 80，先读取规则再执行脚本。”运行记录保留工具输入、版本摘要和 stdout。
5. 上传同名的新内容得到新版本。重复内容复用原版本；已发布 Agent 和已有会话继续读取固定版本。修改草稿不会悄悄替换发布内容。
6. 停用某个 Skill 版本后，后续发布、读取和执行被拒绝。Runtime 每 2 秒检查本次绑定版本；单次控制面请求最多 8 秒。撤销或失联会取消当前模型流及脚本，执行前后还会重新检查。正常连接条件下，进行中的取消不是零延迟。

当前管理入口只支持**平台托管**：原 ZIP、解析文件和版本信息存 PostgreSQL；正文经鉴权的控制面接口供当前 Runtime 读取。这不是客户私网原包默认上报的实现。第三方应用只通过其获准的 Agent 调用 Skill，不能通过应用凭据管理或直接读取 Skill 包。

## 格式与平台限制

格式依据 [Agent Skills 官方规范](https://agentskills.io/specification)，于 2026-09-09 再次核对。`name`、`description` 必需；`license`、`compatibility`、字符串映射 `metadata` 和实验性的 `allowed-tools` 保持标准格式。平台授权不写入 `SKILL.md`，`allowed-tools` 不能代替授权。

ZIP 可直接包含 `SKILL.md`，或包含一个与 name 相同的外层目录。平台限制：压缩包 4 MiB，展开总量 16 MiB，最多 200 个普通文件、240 个归档条目，单文件 2 MiB，路径 240 字符。拒绝加密条目、链接和特殊文件、重复或越界路径、文件与目录冲突、仅大小写或 Unicode 规范化不同的路径。正文超过 500 行仅给编写建议，不作为标准格式错误。

原包记录 SHA-256；规范化文件清单形成内容摘要，每个文件有独立摘要和大小。发布快照固定清单，Runtime 读取时重新校验字节摘要。新的数据库迁移为 v6，不重写旧发布版本。

## 执行环境

Linux 直接安装的 Runtime 需要 Node.js、Docker CLI 和获准使用的 Docker Engine。Runtime Dockerfile 已增加 CLI；该镜像本轮尚未完成构建验收，见下文。执行管理权限通过单独的 Compose overlay 显式配置。业务脚本容器不获得 Docker socket。

```sh
docker build -f deploy/skill-sandbox.Dockerfile -t agent-platform/skill-sandbox:local .
docker image inspect agent-platform/skill-sandbox:local --format '{{.Id}}'
```

将输出的不可变 image ID 配到 Runtime 的 `SKILL_SANDBOX_IMAGE`，也接受预加载的 `repository@sha256:...`。执行时使用 `--pull=never`，不跟随镜像标签、不临时安装依赖。基线镜像包含 Node.js 24、Python 3、Bash；软件包在构建期解析，因此重新构建得到的镜像需要重新验收并固定摘要。

`pnpm dev/preview` 从本地 `.env` 传递该变量。正式 Node 服务使用显式 env-file；Docker 可叠加 `deploy/runtime.skills.compose.yaml`，同时指定 Docker socket 的实际 `DOCKER_GID`。Docker daemon 是受信任的执行管理边界，业务成员不能自行配置镜像、daemon 地址、挂载或启动参数。缺少镜像或 Docker 时，返回 `SKILL_SANDBOX_UNAVAILABLE`，指令读取仍可用，不回退到宿主脚本执行。

模型只可调用 `run_skill_script({skillName, entrypoint, input})`。解释器由服务端按已授权 `.js/.mjs/.cjs/.py/.sh` 入口固定，不接收任意 shell、环境变量或工作目录。`input` 以 JSON 加换行传给 stdin。脚本容器使用 UID/GID 1000、禁网、只读根目录和包卷、drop ALL capabilities、no-new-privileges、128 MiB 内存及相同 swap 上限、0.5 CPU、64 PIDs、30 秒执行时限、stdout/stderr 合计 64 KiB。临时目录 16 MiB，工作目录 32 MiB；各次调用独立。

单次输入不超过 64 KiB；同一 Agent 执行中一次只允许一个脚本，模型并发调用会以 `SKILL_CALL_LIMIT` 终止本次执行。stdout/stderr 在字节限额内分别汇总后解码，避免中文字符跨输出块时被替换成乱码。

包通过停止状态的准备容器放入独立 volume，执行容器只读挂载该 volume。这样 Docker 形态的 Runtime 无需把宿主路径暴露给脚本，也不依赖宿主与 Runtime 的文件路径一致。正常结束、取消、超时和输出超限均清理本次容器、卷和暂存目录；清理失败不能报告成功。`SIGKILL` 或 Docker daemon 崩溃后的残留回收尚待运维闭环，不能用本轮正常路径清理证据替代。

## 验证与当前边界

`pnpm check` 包含 ZIP 异常输入、真实 PostgreSQL/HTTP/生成 SDK/原生 Mastra Skill 读取、版本固定、跨项目和无效租约拒绝，以及现有平台回归。Docker 测试需显式提供固定镜像；未提供时其中两组标记跳过，不能当作隔离通过：

```sh
SKILL_TEST_IMAGE=sha256:<实际镜像ID> node --conditions=development --import tsx --test --test-concurrency=1 tests/runtime/skill-sandbox.test.ts tests/integration/skills.test.ts
```

当前结果是文本 stdout，随受管会话和运行事件持久化；临时工作目录中的文件不会自动成为可下载产物。上传表格的 run 文件引用、产物登记下载、脚本通过受控网关调用业务工具、可配置执行环境目录、私网包存储与传输策略、独立执行管理服务、无 Docker 原生隔离、异常崩溃回收和客户 Linux/amd64 验收仍待后续实现。这些限制不影响当前版本的指令/资料读取、固定入口纯计算脚本和工具调用各自已有的授权边界。

## 本轮实测（2026-09-09）

- 配置固定镜像后，`pnpm check` 的 lint、137 个模块/620 条依赖检查、构建、生成 SDK 一致性、39 个后端与领域测试、19 个 React DOM 测试通过，0 跳过。随后追加中文分块输出与路径规范化用例；中文用例先在旧实现观察到乱码，修复后重新运行 Skills、ZIP 与真实 Docker 测试通过。
- 真实 PostgreSQL、HTTP 和生成 SDK 验证同内容复用、版本固定、分页、跨项目/无效租约拒绝；确定性模型协议 fixture 驱动 Mastra 原生 `skill`、`skill_read` 和 Docker 脚本。工作流 Agent 节点也复用固定发布；模型流已开始后停用版本，运行终止为 `SKILL_ACCESS_DENIED`。
- Docker Desktop Linux ARM64 实测非 root、包/根目录只读、仅 loopback 网络、无宿主 canary 和 Docker socket、Node/Python/Bash 输入输出、输出超限与取消后子进程/私有卷清理。固定沙箱镜像 ID 为 `sha256:0e0ad8c4ee386fcc3a1a9108d0f924912a714d2d09499936a98afb9b5f0795cb`。
- 开发控制台 `http://192.168.110.151:5179` 的「企业知识助手」项目中新增 **Skills 验收 · 合成订单汇总** Agent v1。真实 `qwen3.8-27b` 先读取 `order-summary` 指令和规则，再执行 `scripts/summary.mjs`，返回两笔合成订单（40、80）、总额 120、exitCode 0。运行 `c5cadb1d-cc5a-4cb8-99cb-172bc7142b90` 已成功持久化；之后通过生成 SDK 只读复核 stdout JSON 与版本 ID，没有重复创建或再次调用模型。
- Skills 管理界面的目录失败重试、文件读取取消、上传错误保留选择、关闭后的迟到响应隔离已通过 React DOM 测试；AntD 检查为 0 issues。CUA 看到了新版主页和 Skills 导航，但后续浏览器连接反复超时/`Debugger unattached`，完整上传、绑定和对话交互的浏览器验收未完成。
- 沙箱镜像已构建并实际执行。新增 Docker CLI 的 Runtime 交付镜像构建及重复拉取被 Docker Hub 的 TLS handshake timeout 阻断。本轮真实模型运行使用 macOS 上的 Node Runtime 管理 Docker Desktop；不能据此声称新版 Runtime 容器、客户私网或目标 Linux amd64 已验收。上一轮导出的安装包和镜像不包含本轮 Skills 实现。
