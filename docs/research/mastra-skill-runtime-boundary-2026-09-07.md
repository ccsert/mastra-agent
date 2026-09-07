# Mastra Skill 加载与隔离执行的适配边界

日期：2026-09-07。对应问题：[核实 Mastra Skill 加载、文件系统与沙箱执行的适配边界](../../.scratch/agent-platform/issues/16-mastra-skill-runtime-seam.md)。

研究结论：可以直接复用 Mastra 的 Skill 发现、按需读取、版本内容源和 Workspace provider 接口；**用户授权的“发布包内脚本自主执行”需要平台提供受控执行工具与客户侧执行服务，不能直接等同于开放 Mastra 的通用 shell 工具。** 下文区分已查明的框架行为与平台设计建议，不代表沙箱部署已通过验证。

## 证据基线

- 官方文档按本日访问状态核实，原 `/docs/workspace/*` 文档部分已迁移到 `/docs/sandbox/*`。
- 源码固定为 [`mastra-ai/mastra` 的 `62da1b231af65b86a367fb221d8a183bbecea6c8`](https://github.com/mastra-ai/mastra/tree/62da1b231af65b86a367fb221d8a183bbecea6c8)，由只读 `git ls-remote` 取得。以下源码结论均指这一 revision。
- 当日 npm registry 的 [`@mastra/core/latest`](https://registry.npmjs.org/@mastra%2fcore/latest) 返回 `1.64.0`，Node 要求 `>=22.13.0`。这是已发布包元数据，**没有证明该版本与上述 main revision 完全一致**；实施前须固定一组实际安装版本并验证接口。
- 本次仅阅读官方文档、源码及包元数据；未安装依赖、执行 Skill、启动沙箱或创建 Git 仓库。

## Skill 加载可以复用的部分

1. **发现与按需加载。** 配置 `Workspace.skills` 后，Mastra 把可用 Skill 的名称、描述、路径及来源加入 Agent 上下文；`skill` 返回完整指令和资源列表，`skill_read` 读取资源，`skill_search` 搜索指令及参考资料。加载是无状态的工具返回，并非一个有执行权限的“激活会话”。读取脚本文件本身不执行脚本。[官方 Skills 文档](https://mastra.ai/docs/sandbox/skills)、[Skill 工具源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/tools.ts#L1-L56)

2. **请求范围内的发现。** `skills` 可为接收 `requestContext` 的同步或异步 resolver，`WorkspaceSkills.getScoped()` 将当次解析的路径集固定在请求视图中。它适合输入平台已验证的身份和绑定结果；框架不会自行判断租户身份是否可信。名称重复还存在优先级或歧义规则，平台应在发布绑定时避免同名冲突。[Skills 文档](https://mastra.ai/docs/sandbox/skills)、[范围视图源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/workspace-skills.ts#L152)

3. **版本内容源。** `SkillSource` 是只读接口，包含 `exists/stat/readFile/readdir`，可选 `realpath`。框架已有 `VersionedSkillSource`，通过 `SkillVersionTree` 的文件路径到 blob hash 映射读取内容；`CompositeVersionedSkillSource` 把多个版本树组合成可发现的虚拟目录。这是现成的发布版本读取接入点，无需先实现完整文件系统才能接入对象存储。[接口源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/skill-source.ts)、[单版本内容源](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/versioned-skill-source.ts)、[组合内容源](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/composite-versioned-skill-source.ts)

4. **版本来源必须明确选择。** Workspace 优先使用显式 `skillSource`，其次配置文件系统，最后读取本地磁盘。组合版本内容源允许显式配置 live fallback；发布执行建议不配置 fallback，并只装入绑定版本。`skillSource` 本身是实例字段，不是文档中的动态 resolver；`skills` resolver 只能选择该 source 内的路径。平台应按发布绑定组合构建或缓存 Workspace/source，避免在共享实例上替换租户的内容源。[Workspace 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/workspace.ts#L950-L965)、[组合源路由行为](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/composite-versioned-skill-source.ts#L91-L126)

**虚拟版本目录不是脚本可执行挂载。** `SkillSource.readFile()` 返回字节或文本，没有挂载、解释器、进程启动、环境镜像接口。平台仍须把相同版本树的内容物化进客户侧只读目录或镜像，保证 Agent 读到的指令版本和实际执行文件一致。此结论由上述接口边界推导。

Mastra 的加载校验也不能代替平台上传验收：当前源码有意容忍某些非严格格式，例如 `compatibility` 接受任意值，`metadata` 值不局限字符串。完整标准校验、归档校验仍应在入库前独立完成；本报告不重复包格式规则。[解析校验源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/skills/schemas.ts#L178-L198)

## 三种权限不能混为一谈

| 控制 | 当前框架行为 | 平台不能据此声称的能力 |
|---|---|---|
| `tools.enabled` | 生成工具时控制工具是否暴露；默认 `true`，支持请求上下文函数 | 不等于底层服务拒绝直接 API 调用，也不能拦截已启动脚本的文件或网络行为 |
| `requireApproval` | 生成工具的审批标记，默认 `false`；可按调用参数动态判断 | 不是 Skill 版本授权数据库，不会自动核对包 hash、资源范围或审批人身份 |
| `requireReadBeforeWrite` | 文件写工具的先读约束，用于防止未了解内容便覆盖 | 不是文件访问授权，也不能约束脚本用系统调用改文件 |
| `LocalFilesystem.readOnly` | provider 的写操作被拒绝，静态只读配置还会过滤对应写工具 | 不保证同一路径通过 shell、挂载或另一 provider 访问时只读 |
| `LocalFilesystem.contained` | 默认 `true`；限制该 provider 的路径访问在 basePath 和显式 allowedPaths 内 | 不是宿主进程、网络或整个客户 Runtime 的隔离 |
| `nativeSandbox` | 显式启用 Seatbelt/Bubblewrap 后，执行器生成 OS 策略 | 不自动承载业务 Tool/MCP 资源授权；不同 backend 的访问效果不能互相代证 |

依据：[工具配置及包装源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/tools/tools.ts#L128-L183)、[文件系统实现](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/filesystem/local-filesystem.ts#L49-L87)、[原生策略类型](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/types.ts)。

`Workspace.tools.hooks.beforeToolCall` 可以拒绝生成工具的调用，`afterToolCall` 可记录成功或异常，是审计和策略接入点。但直接调用 `sandbox.executeCommand()` 不经过该工具包装层；平台自定义 Tool、工作流 Step、管理 API 必须共用执行服务的授权检查。Skill 的三种读取工具由独立 `createSkillTools()` 路径创建，不能仅凭 Workspace 的通用工具开关推断它们也被禁用；用已授权的 SkillSource/路径集限制可见内容，并按最终工具清单验收。[包装与 hooks 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/tools/tools.ts#L334-L363)、[Agent 的两条工具注入路径](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/agent/agent.ts#L3926-L4034)

## 默认 LocalSandbox 的实际边界

- 默认 `isolation: 'none'`，命令直接在应用宿主执行，使用应用进程的 OS 权限。`workingDirectory` 只决定起始目录，内置命令工具还允许传 `cwd`。默认环境仅带 `PATH`，不会自动继承全部环境变量，但这不限制脚本读取宿主文件或联网。[官方概览](https://mastra.ai/docs/sandbox/overview)、[构造及环境源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/local-sandbox.ts#L228-L252)、[环境构造](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/local-sandbox.ts#L648-L653)
- `seatbelt` / `bwrap` 必须显式选中；请求的后端不可用时构造会抛错。原生配置默认禁网，但 Seatbelt 生成策略允许广泛读取文件；Bubblewrap 是另一套文件挂载与 namespace 规则。不能把“启用原生隔离”描述为统一的按资源只读目录白名单。[Seatbelt 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/seatbelt.ts#L85-L191)、[Bubblewrap 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/bubblewrap.ts#L46-L128)
- **只读挂载需要单独验证。** 当前 `LocalSandbox.mount()` 的 local 路径通过软链接挂载，并把目标加入原生 `readWritePaths`；该过程没有按 `LocalFilesystem.readOnly` 转为 OS 只读挂载。`nativeSandbox.readOnly` 也明确保留 mounted targets 可写的例外。因此生产版本目录不应依赖这个默认 local mount 实现取得不可变性。[local mount 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/local-sandbox.ts#L742-L768)、[加入可写范围](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/local-sandbox.ts#L927-L964)、[只读例外说明](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/types.ts#L66-L77)

此处是源码行为核查，不是对某个原生 sandbox 的完整安全审计。客户侧隔离方案应在后续选定部署条件下单独验证。

## 包内脚本执行与通用 shell 的分界

内置 `execute_command` 接收自由文本 `command` 和 `cwd`，会原样进入 `sandbox.executeCommand(command, [], options)` 或后台 `processes.spawn(command, ...)`。LocalSandbox 非隔离路径启用 shell，原生包装路径内部也使用 `sh -c`。它能够运行任意 shell 组合及解释器内联代码，没有 `skillVersionId` 或“只运行已发布脚本”的内置约束。[工具 schema 与调用](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/tools/execute-command.ts#L14-L29)、[前台执行](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/tools/execute-command.ts#L214-L228)、[LocalProcessManager](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/local-process-manager.ts#L208-L271)

**建议平台模型可见接口为 `run_skill_script`，而不是把通用 shell 更名。** 此名称和以下参数是平台设计建议，不是 Mastra API：

```text
run_skill_script(skillVersionId, entrypointId, input)
    → 已验证的调用身份 + Run 绑定版本 + 有效授权
    → 固定解释器与只读脚本路径 + 结构化输入
    → 客户侧执行服务
    → 受限沙箱 + 已固定依赖环境
```

- 禁用生成的 `EXECUTE_COMMAND`；首期不需要的后台进程、computer、任意写文件能力也不暴露给模型。将平台工具通过 Mastra `createTool()` 接入。
- 发布记录生成入口清单，将稳定 `entrypointId` 映射到已校验的包内脚本及输入契约。它属于平台记录，不强迫标准 Skill 包携带平台私有格式；平台可扫描候选脚本并由发布人选择入口。
- 服务端选定解释器、脚本绝对路径、环境 digest、工作目录和限额。模型不传任意 command、解释器选项、`cwd` 或 `env`；输入经 schema 校验并使用结构化传输，不能拼进 shell 文本。
- 底层执行服务校验 `客户 / 调用主体 / Run / Skill 版本 / 入口 / 资源范围 / 授权状态`，随后自主运行。无授权时拒绝或进入既定扩权流程；已授权范围内不逐次弹审批。
- 固定入口并不证明脚本内部不会启动子进程、动态导入或向外请求。真正的访问约束由 sandbox/provider 和受控工具网关执行。包与依赖只读、临时输出可写；脚本所需业务 Tool/MCP 经带范围的服务端能力入口调用。
- 任意生成并执行新代码应作为额外产品能力另行决定，不能从用户现有的包版本授权中推导。

## Provider 与发布环境的可行接入

Mastra 暴露 `WorkspaceFilesystem` / `WorkspaceSandbox` 接口，并导出 `MastraFilesystem` / `MastraSandbox` 基类；Sandbox 提供生命周期、命令结果、取消和可选后台进程等能力。可以包装客户私网内的执行服务，无需为了使用 Skill 把计算搬到 Mastra 托管平台。抽象接口本身不保证内存、CPU、网络和租户隔离，保证来自具体实现。[官方 Filesystem 接口](https://mastra.ai/reference/workspace/filesystem)、[官方 Sandbox 接口](https://mastra.ai/reference/workspace/sandbox)、[公开导出](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/index.ts#L10-L14)

`Workspace` 支持按请求解析 filesystem/sandbox，支持 `sandboxCacheKey` 复用同一执行环境。静态 sandbox 则由使用该实例的请求共享；resolver 返回的环境由应用负责销毁，`clearSandboxCache()` 只清引用。平台需要自行提供持久执行记录与跨进程恢复，不把进程内 Map 当作 Runtime 调度数据库。[官方生命周期与 resolver 说明](https://mastra.ai/docs/sandbox/overview)、[缓存源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/workspace.ts#L878-L929)

Node.js / Python / Bash 与依赖的固定属于平台发布环境：建议准备完成后记录解释器版本、依赖锁定结果和环境 digest，再进入可执行状态；任务期不赋予在线安装依赖的通用命令入口。可在 provider 的创建/启动流程接入准备，但仅有 `onStart` 不等于环境已准备好：当前基础生命周期在 hook 前已进入 running 状态，文档提醒并发 command 可能交错，且 hook 早于挂载。执行服务应在自己的 ready 状态达成后才接任务。[Sandbox 生命周期说明](https://mastra.ai/reference/workspace/sandbox)

## 复用与平台自建责任矩阵

| 范围 | 优先复用 | 平台承担 |
|---|---|---|
| Skill 阅读体验 | 发现、按需加载、搜索、资源读取 | 按租户和发布绑定构造可见集合；标准归档导入验收 |
| 版本内容 | Versioned / CompositeVersionedSkillSource、blob 读取模型 | 版本批准、分发、撤销、客户缓存，以及读取与执行的一致性 |
| 模型脚本入口 | `createTool()` 接入和工具结果流 | 受控 `run_skill_script`、入口清单、输入契约、版本范围授权 |
| 文件访问 | Filesystem provider 与接口 | 包/输入/输出的 OS 挂载策略；与租户身份绑定的路径权限 |
| 执行环境 | Sandbox provider 接口、生命周期、结果及取消 | 客户侧隔离、固定语言和依赖、资源限额、网络出口、凭据能力 |
| 审批与审计 | 工具审批机制、工具 hooks、Skill tracing 接入点 | 授权事实来源、身份校验、不可篡改审计关联、撤销传播、完整性 |
| 运行恢复 | resolver 和 provider 能力抽象 | durable Run 状态、sandbox 归属、并发隔离、清理和失败恢复 |

以上“优先复用”以本报告所列官方接口为依据；“平台承担”是满足本项目版本与范围授权要求的设计责任，不能解读为 Mastra 全部产品中不存在任何相关扩展。

## 仍需原型回答的问题

1. 固定发布包版本是否确实包含上述 source/resolver/hooks 接口；最终 lockfile 下编译验证。
2. 同租户不同 Run、跨租户并发是否能始终读取和执行各自固定版本；发布升级后旧 Run 是否仍命中旧内容。
3. 客户侧选定 provider 对只读包、只读输入、可写输出、禁网或受控出口、超时及子进程取消的实际效果。
4. 固定入口能否覆盖代表性的 Python、Node.js、Bash Skill；哪些脚本必须被拒绝或要求新版本补充输入契约。
5. 授权撤销在已运行进程与新调用上的语义，以及控制面断连时客户 Runtime 能否验证有效范围。
6. 冷启动、依赖环境重建、沙箱重连与清理期间，服务端 ready/授权检查是否仍覆盖所有入口。

这些未知项不影响“复用 Mastra 内容加载，平台控制包内脚本执行”的接口方向，但当前不能宣称目标私网部署已经具备生产隔离与恢复能力。
