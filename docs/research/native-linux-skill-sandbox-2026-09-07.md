# Linux 直接安装时的 Skill 脚本隔离

日期：2026-09-07。状态：研究完成，方案待原型验证。用户已确认 Runtime 以 Docker 为主，同时允许 Linux 直接安装；本文没有把后者解释成允许上传脚本使用 Mastra 服务进程的权限直接运行。

来源：[Linux 直接安装模式下的脚本隔离路径](../../.scratch/agent-platform/issues/19-native-linux-sandbox.md)。延续[容器隔离研究](private-skill-sandbox-options-2026-09-07.md)及[Mastra Skill 边界研究](mastra-skill-runtime-boundary-2026-09-07.md)，只补充原生 Linux 路径。

## 建议的部署能力矩阵

**Runtime 安装方式和脚本执行后端分开声明。** Linux 进程安装的 Mastra 可以调用客户侧 Docker／OpenSandbox 服务，无需为了“直接安装”同时重做一套无 Docker 沙箱。OpenSandbox 当前仍以 Docker／Kubernetes 为后端，不能在完全无容器引擎时把它当作原生进程沙箱。[OpenSandbox server 配置](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/server/configuration.md)

| Runtime 安装 | 客户执行条件 | 建议支持形态 | 尚需证明 |
|---|---|---|---|
| Docker | Docker + 已验收脚本后端 | 首要交付路径；Mastra 调用独立的脚本执行服务 | 固定镜像、文件／网络策略、资源限制和取消真正生效 |
| Linux 服务进程 | 本机或客户内网有同样的 Docker／OpenSandbox 执行服务 | 保留直接安装入口，复用同一执行契约 | 服务身份、连接鉴权、安装与运行清理；不要给脚本 Docker socket |
| Linux 服务进程 | 完全无 Docker；有 bwrap、可用 user namespace、systemd/cgroup 等执行设施 | 原生适配候选，按能力宣告可接的任务 | 原生文件／网络范围、资源及后代进程限制、依赖 ABI |
| Linux 服务进程 | 缺少任务所需的强制约束机制 | Runtime 可承载不依赖该脚本能力的功能；拒绝对应脚本任务，报告能力缺口 | 不允许静默降级为 `isolation: none` |

矩阵后三列是平台设计建议，不是已经实现或用户已选定的后端保证。Docker 的内核隔离等级仍取决于实际运行时和配置，见前一份研究。

## Bubblewrap 的能力和前提

本次固定读取 **Bubblewrap v0.11.2，commit `1b80120ef26a28e065e67f89bfef873f13bdd317`**。这是研究证据版本，不是承诺安装旧版；部署时需要选发行版支持并修复安全问题的版本。该版 setuid 模式已弃用且默认关闭，不能把给二进制加 setuid 当作通用安装方案。[固定 README](https://github.com/containers/bubblewrap/blob/1b80120ef26a28e065e67f89bfef873f13bdd317/README.md)

| 需求 | 可复用机制 | 不具备的保证／部署前提 |
|---|---|---|
| 文件范围 | 新 mount namespace；`--ro-bind` 只读输入／依赖，`--bind` 挂载本次可写工作区 | 参数决定可见范围；把整个宿主 `/` 只读挂入仍允许读取其内容。需防止宿主密钥、IPC socket 和共享工作区进入挂载集 |
| 禁止外网 | `--unshare-net` 创建只有 loopback 的网络 namespace | 不等于所有 IPC 都禁用；挂入的文件系统 Unix socket 仍需单独约束 |
| 按目标联网 | bwrap 本身没有域名、端口和业务 Tool 权限模型 | `--share-net` 是共享网络，不是允许列表。需要受控代理／工具代理和不可绕过的网络强制机制 |
| 子进程 | PID namespace、内部 PID 1 回收、`--die-with-parent`；可传 seccomp 规则 | PID namespace 不限进程数量；cgroup namespace 不创建 CPU／内存／PID 配额。资源和总时限要由执行管理器补齐 |

依据：[bwrap 参数手册](https://github.com/containers/bubblewrap/blob/1b80120ef26a28e065e67f89bfef873f13bdd317/bwrap.xml)。Bubblewrap 官方明确将它定位为构建沙箱的工具，具体策略由调用者负责；共享宿主内核，不能单独宣称为完整企业级隔离。

运行用户必须能够创建所需 namespace。Linux 内核配置、sysctl、发行版 AppArmor／SELinux 策略以及上层服务限制均可能阻止它。Ubuntu 的 AppArmor user namespace 策略可按程序授权，官方还提供 bwrap profile 指引；建议安装前检测并提供适配该发行版的策略，而不是要求全局关闭宿主防护。[Ubuntu 官方说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)

## systemd 可以补齐什么

以下固定核对 **systemd v258** 的官方手册源码；实际宿主版本、cgroup 控制器与委托状态必须检测，不能只检查配置字段存在。

- **每次执行单独管理资源。** systemd service/scope 可通过 cgroup 设置 `CPUQuota`、`MemoryMax`、`TasksMax`。建议由受控执行管理器创建每次运行的单元；脚本不应获得移动到其他 cgroup 或创建无限制服务的权限。用户级 systemd 是否能限额取决于上层控制器委托。[资源控制](https://github.com/systemd/systemd/blob/v258/man/systemd.resource-control.xml)
- **取消覆盖后代进程。** `KillMode=control-group` 停止单元内全部进程，结合 `TimeoutStopSec` 和最终 SIGKILL。service 可用 `RuntimeMaxSec`，但它不约束 `Type=oneshot` 的启动阶段；oneshot 应使用相应启动超时。不能只 kill Node 创建的直接子进程。[停止策略](https://github.com/systemd/systemd/blob/v258/man/systemd.kill.xml)、[服务时限](https://github.com/systemd/systemd/blob/v258/man/systemd.service.xml)
- **文件与身份。** `User`／`DynamicUser`、`NoNewPrivileges`、`ProtectSystem`、`BindReadOnlyPaths` 可参与隔离；不同运行使用独立工作区，执行身份应与保存 Runtime 凭据的服务身份分离。只读路径仍可包含可访问的 Unix socket，不能用只读挂载代替 IPC 授权。[执行环境](https://github.com/systemd/systemd/blob/v258/man/systemd.exec.xml)
- **网络限制有条件。** `PrivateNetwork` 创建只有 loopback 的网络；`IPAddressDeny/Allow` 通过 cgroup/eBPF 限制 IPv4/IPv6 地址，不提供业务操作权限。内核没有对应 BPF 支持时 IP 策略可能无效；`RestrictAddressFamilies` 也不是域名允许列表，且对传入的 socket 等路径有限制边界。平台必须验证实际阻断，不能依据 unit 文件就报告支持受限联网。[网络与资源控制](https://github.com/systemd/systemd/blob/v258/man/systemd.resource-control.xml)、[执行环境限制](https://github.com/systemd/systemd/blob/v258/man/systemd.exec.xml)

具体组合可采用“无普通网络出口的 bwrap + 只暴露本次授权的工具代理入口”，或“独立网络 namespace + 宿主强制只允许访问代理”。这是候选设计：工具代理仍须验证每次运行的身份和资源范围，`HTTP_PROXY` 环境变量本身不能强制所有脚本经过代理。

## Mastra 原生适配与依赖准备

沿用已核验 Mastra commit `62da1b231af65b86a367fb221d8a183bbecea6c8`：`LocalSandbox` 的无隔离路径直接运行宿主命令；选择 `bwrap` 才生成 namespace／mount 参数。其 `allowNetwork` 是布尔开关，打开后不再创建独立 network namespace；不提供按工具限网。默认还读取宿主系统目录；自定义 `bwrapArgs` 会整体替代生成策略，须由平台管理而非上传者提供。[bwrap 源码](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/bubblewrap.ts)、[配置类型](https://github.com/mastra-ai/mastra/blob/62da1b231af65b86a367fb221d8a183bbecea6c8/packages/core/src/workspace/sandbox/native-sandbox/types.ts)

因此仅开启 `nativeSandbox` 不足以满足本平台的版本、授权、配额和取消契约。尤其既有研究发现 local mount 会把目标加入可写范围，不能依赖它保障发布包不可变；复用接口时仍需独立执行管理器与 OS 强制策略。[已有源码核查](mastra-skill-runtime-boundary-2026-09-07.md)

无 Docker 模式可预先构建并只读挂载解释器／依赖目录或独立 rootfs，但普通 venv／node_modules 不是完整跨主机运行环境。Python wheel 带 Python、ABI 和平台标签，manylinux／musllinux 对 libc 有要求；Node-API 的 ABI 稳定性也不覆盖所有外部原生库。因此依赖制品至少按架构、libc、解释器及所需系统库建立兼容组合，记录摘要；直接绑定宿主 `/usr` 时，宿主升级也会改变执行环境。[Python 平台标签](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/)、[Node-API ABI 边界](https://nodejs.org/api/n-api.html#implications-of-abi-stability)

## 原型需要证明的最小集合

1. 同一已发布 Skill 在 Docker Runtime、Linux Runtime + Docker 后端中执行相同契约；安装形式不改变身份和授权。
2. 无 Docker 原型在明确发行版上验证 user namespace、文件读写、IPC、禁网及代理绕过；缺机制时拒绝，不静默回退。
3. CPU／内存／进程耗尽只影响本次运行；取消、超时、执行管理器退出后无遗留进程，cgroup 和工作目录能清理。
4. 不同运行之间无法读取对方文件／凭据，也不能访问 Runtime 的服务身份、管理 socket 或服务管理入口。
5. 两种主机 ABI／版本或至少一次宿主升级验证依赖兼容检测；环境不兼容时停在准备失败，不临时在线安装。

本轮仅研究，没有安装 bwrap、配置 systemd、启动脚本或证明上述约束已生效。建议先完成 Linux 直接安装复用 Docker 后端，再以明确客户条件验收完全无 Docker 的原生后端。
