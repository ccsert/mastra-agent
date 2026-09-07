# 客户私网中的 Skill 脚本隔离与环境准备

日期：2026-09-07。状态：研究完成，候选待决；没有部署、拉取镜像或运行隔离测试。

问题来源：[核实客户私网中的脚本隔离与环境准备方案](../../.scratch/agent-platform/issues/17-private-sandbox-options.md)。输入基线是已授权的标准 Agent Skills 包、Node.js／Python／Bash，以及执行前准备并固定依赖。本文不修改这些产品决策，也不替用户选择客户部署形态。

## 结论

**没有 Kubernetes 的客户也有可行路径。** 可以在客户 Linux 主机或虚拟机上部署 Docker，由平台直接管理容器；也可以加一层自托管 OpenSandbox，复用命令、文件、流式输出和生命周期 API。需要提高对不可信脚本的隔离时，两者都仍要安装并配置 gVisor／Kata 等实际运行时。OpenSandbox 不是替代 Docker／Kubernetes 的第三种内核隔离技术。[Docker 替代运行时](https://docs.docker.com/engine/daemon/alternative-runtimes/)、[OpenSandbox 运行时配置](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/guides/secure-container.md)

**条件建议：** 普通 Docker 适合受控脚本的开发验证；已有 Kubernetes 且以批处理为主的客户，可以优先验证 Job + RuntimeClass；需要交互式多次命令执行、文件操作和统一 SDK 的客户，值得优先验证 OpenSandbox。第三方上传包经过业务授权，不代表代码已变成可信代码；是否允许普通容器作为生产执行边界，仍取决于客户的信任模型和验收结果。

## 证据版本与项目身份

| 项目 | 本次核验依据 | 部署与许可证边界 |
|---|---|---|
| Docker Engine／Moby | 当日官方 Engine 文档；未替客户指定 Engine 版本 | 可在客户 Linux 主机自托管；Moby 为 Apache-2.0。Docker Desktop 的产品许可另计，不能把 Desktop 条款直接套到 Linux Engine。[Engine](https://docs.docker.com/engine/)、[Moby LICENSE](https://github.com/moby/moby/blob/master/LICENSE) |
| Kubernetes | 当日官方 Pod、Job、RuntimeClass、NetworkPolicy 文档；实际集群、CRI、CNI 版本待原型锁定 | 自托管或使用客户已有集群；项目为 Apache-2.0。[LICENSE](https://github.com/kubernetes/kubernetes/blob/master/LICENSE) |
| OpenSandbox | 当前仓库为 **opensandbox-group/OpenSandbox**；旧地址 `alibaba/OpenSandbox` 会重定向。本文细节固定在 **server/v0.2.3 对应 commit `c39b814f36ded4c61d5ac6f9332ee4dfbab86c00`**；另核验到主干 HEAD `5727934ece0749a8674fa44897c1ef7934e8a065`，未混用主干新增能力 | Apache-2.0，自托管 FastAPI server；Python ≥ 3.10。官方 server 文档列 Docker Engine ≥ 20.10 或 Kubernetes ≥ 1.21.1，这只是上游声明的门槛，不是我们支持旧版本的承诺。[仓库](https://github.com/opensandbox-group/OpenSandbox)、[固定版本 LICENSE](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/LICENSE)、[Server requirements](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/components/server.md#requirements) |

OpenSandbox 的 server、execd、egress、SDK 和 Helm Chart **分别发版**，`server/v0.2.3` 不是整套镜像的统一版本。原型必须记录全部组件版本和镜像 digest；当前没有生成经过兼容性验证的部署组合。[发布列表](https://github.com/opensandbox-group/OpenSandbox/releases)

## 能力事实矩阵

表内“平台负责”是根据已核验能力推导出的集成责任，不代表上游缺陷。

| 能力 | 直接管理普通 Docker 容器 | Kubernetes Pod／Job + 隔离运行时 | OpenSandbox 自托管 |
|---|---|---|---|
| 生命周期 | 有 create/start/exec/stop/remove；平台负责队列、TTL、孤儿清理、任务状态映射 | Pod 提供执行单元，Job 管理完成与重试；平台负责业务幂等、结果收集 | 有创建、查询、删除、TTL、续期、命令执行、文件操作、SSE；支持 Docker／Kubernetes 后端 |
| 固定环境 | 运行自有 OCI 镜像并固定 digest | Pod `image` 指向同一类固定镜像；集群负责拉取 | 接受公共／私有镜像；server 注入 execd。固定依赖仍由我们的构建流程准备，不会因为接入 OpenSandbox 就自动锁定 |
| 文件范围 | 可设只读根文件系统、只读输入挂载、独立可写目录；任意 host bind 需要平台限制 | `readOnlyRootFilesystem`、只读卷、临时卷和安全上下文；PVC／hostPath 的授权由平台与集群执行 | 有 volume `readOnly` 和 host 路径允许列表；**未发现 Docker 后端同等的整根文件系统只读配置**，不能宣称已满足只读根要求 |
| 网络 | bridge 默认可出网；`none` 可禁用外部连接。域名／工具目标允许列表需防火墙或受控代理实现 | NetworkPolicy 需支持它的 CNI；原生 API 主要控制 L3/L4，域名／HTTP 操作权限需额外机制 | 可选 egress sidecar；DNS-only 不约束直接 IP，严格限制需验证 `dns+nft` 及宿主网络配置；默认配置不能直接作为平台授权策略 |
| CPU／内存／进程 | cgroup 限额和 `pids-limit`，必须显式配置 | requests/limits + 配额；PID 上限属于 kubelet 节点配置，并非通用 Pod `resources.limits.pids` | Docker 映射 CPU／内存并支持 server 级 `pids_limit`；Kubernetes 仍依赖 Pod 模板、节点及 CNI 配置 |
| 凭据 | 环境变量／文件中注入的凭据可被同权限脚本读取；须由平台约束凭据范围 | Secret 挂载也不会让脚本“用得到但读不到”；可禁用默认 ServiceAccount token 挂载 | 除环境变量外有 Credential Vault 代理注入，但有协议、端口及部署限制；不是企业工具授权的完整替代 |
| 取消与超时 | stop 先发停止信号，宽限期后 kill；平台负责总时限和确认退出 | Job `activeDeadlineSeconds` 控制总时限；删除 Job 时需正确级联删除 Pod | 普通命令 API 有超时和 interrupt；删除 sandbox 可终止整个环境，sandbox TTL 与命令超时是不同层次 |

Docker 矩阵依据：[运行参数](https://docs.docker.com/engine/containers/run/)、[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)、[网络](https://docs.docker.com/engine/network/)、[停止语义](https://docs.docker.com/reference/cli/docker/container/stop/)。Kubernetes 依据：[安全上下文](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)、[资源管理](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)、[PID 配置](https://kubernetes.io/docs/concepts/policy/pid-limiting/)、[ServiceAccount 挂载](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#opt-out-of-api-credential-automounting)。OpenSandbox 依据：[生命周期与执行 API](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/api/index.md)、[Docker HostConfig 源码](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/server/opensandbox_server/services/docker/container_ops.py#L344-L384)、[卷映射源码](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/server/opensandbox_server/services/docker/volumes.py#L388-L390)。

## 固定依赖如何落实

三条路径都可采用同一套**执行镜像契约**。这是平台设计建议：将 Skill 包摘要、基础镜像 digest、语言版本、依赖锁文件摘要、构建参数、最终镜像 digest 关联到发布版本；执行时只使用已准备好的镜像，缺依赖返回环境未就绪。基础镜像 tag 可移动，固定 tag 不等于固定内容。[Docker 构建与 digest](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions)

| 类型 | 可复用的准备方式 | 仍需平台补齐 |
|---|---|---|
| Node.js | 在构建阶段基于 `package-lock.json` 执行 `npm ci`；锁文件与 manifest 不匹配时失败。[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) | 固定 Node/npm 和构建选项；明确安装脚本许可。`npm ci` 解决安装一致性，不能证明依赖可信 |
| Python | 固定所有直接和传递依赖，使用哈希校验；有合适 wheel 时优先离线 wheel 集合。[pip secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/) | 固定 Python／平台 ABI；源码构建依赖也要固定，离线仓库应有完整制品 |
| Bash／系统工具 | Bash、curl、文档转换器等进入固定镜像；构建阶段准备，运行阶段不临时执行包管理器 | 系统包来源、版本和原生库也须记录，不能只锁 npm/pip |

构建本身可能执行依赖安装脚本，因此应使用与业务凭据分离的构建环境。推理中的 Agent 不获得 Docker socket、集群管理 kubeconfig 或构建仓库写凭据。固定制品与文件／网络授权是两项不同约束；容器中可写目录里仍能创建新文件，单靠禁用包管理器不能证明只能执行预装代码。

## 隔离边界与宿主前提

- **普通容器共享宿主内核。** namespace、cgroup、seccomp、capabilities 和非 root 用户分别限制可见资源、配额、系统调用和权限；组合使用才形成具体边界。Docker daemon 的管理权限尤其敏感，官方明确要求只向可信操作者开放。[Docker security](https://docs.docker.com/engine/security/)
- **gVisor** 使用 Sentry 实现应用看到的系统调用接口，减少应用直接触及宿主内核的面；它不是完整硬件虚拟机，也不会自动替平台限制网络和资源。需要安装 `runsc`，Kubernetes/containerd 还需要对应 shim／handler；真实原生依赖、文件 I/O 和系统调用兼容性需要验证。[gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/security/)、[兼容性](https://gvisor.dev/docs/user_guide/compatibility/)
- **Kata** 通过轻量 VM 增加独立 guest kernel 边界；需相应虚拟化能力、宿主运行时和镜像支持。若客户 Runtime 所在机器本身是 VM，还需确认所选后端的嵌套虚拟化可用性，不能根据有 Docker 就推定可用。[Kata 官方项目](https://github.com/kata-containers/kata-containers)
- **RuntimeClass 是 Kubernetes 内置资源，不是 CRD。** 它选择已有 CRI handler；创建一个 RuntimeClass 名称不会安装运行时。只应调度到完成配置的节点，并计入隔离运行时额外开销。[RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- **Kubernetes namespace 不是内核隔离边界。** NetworkPolicy 也不能代替内核隔离、RBAC、存储控制或应用授权；必须有实际执行策略的 CNI。先建立默认拒绝策略，再接纳工作负载，并验证策略真正生效。[多租户](https://kubernetes.io/docs/concepts/security/multi-tenancy/)、[NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

OpenSandbox 的 secure-container 文档把多种运行时概括为 “hardware-level” 并将 RuntimeClass 称作 CRD；上面采用各技术自身的一手文档修正这些表述，没有沿用其示例启动耗时作为性能承诺。

## OpenSandbox 需要特别验证的缺口

1. **配置默认值不等于我们的授权基线。** 固定版本配置中 Docker `network_mode` 默认是 `host`；传入 `networkPolicy` 要求 `bridge`。egress 默认模式是 `dns`，`dns+nft` 才增加 IP/CIDR 控制；IPv6 仍有覆盖缺口。`allowed_host_paths=[]` 拒绝请求中的 host 挂载，但管理员全局 `sandbox_binds` 是另一条配置路径，也要纳入审查。[固定配置参考](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/server/configuration.md)
2. **Sidecar 是执行网络规则的组件，不是额外内核边界。** egress 需要 `NET_ADMIN` 和相应 Linux 网络设施，应用容器不应获得该能力。已有透明 service-mesh sidecar 的 Pod 暂不受支持；Pool 已创建的 Pod 不能再按每次请求插入 egress，`networkPolicy + poolRef` 会被拒绝。若选择 Pool，须在 Pool 模板预置策略并验证不会跨授权范围复用。[egress 文档](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/components/egress.md)
3. **更强隔离必须实际启用。** `[secure_runtime]` 是 server 级配置，Docker 映射到已安装的运行时名，Kubernetes 映射到 RuntimeClass。没有配置时仍是普通运行时。不能由脚本自行决定此配置。[secure runtime guide](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/guides/secure-container.md)
4. **不要顺手启用同容器内的额外隔离特性。** 此版本 `bootstrap.execd.isolation=enable` 会给 Docker 容器添加 `SYS_ADMIN` 并将 AppArmor/seccomp 设为 unconfined，为 bwrap 提供前提；它改变了外层容器边界，不能仅因名称包含 isolation 就当成加固开关。首个 PoC 可先验证每次运行独占 sandbox，暂不引入该选项。[源码](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/server/opensandbox_server/services/docker/docker_service.py#L896-L914)
5. **凭据代理需要单独验收。** Credential Vault 通过 egress 的透明 HTTPS 代理按目标／路径／方法注入凭据，要求 `dns+nft` 等前提；Vault 状态在 sidecar 内存中，Kubernetes pause/resume 后需重新注入。文档列出自定义端口匹配限制，不能直接覆盖所有企业内网 API。它适合作为候选，平台仍需管理用户授权、业务工具权限和审计。[Credential Vault](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/guides/credential-vault.md)
6. **快照不是依赖锁定，也不是业务执行恢复。** Kubernetes pause/resume 保存 rootfs 至 OCI registry，并重建 Pod；它不能据此证明任意脚本进程内存、工具调用事务都可恢复。其 snapshot commit Job 需要挂载节点 containerd socket，属于可信基础设施，不能让上传的 Skill 镜像接管。首期若不需要会话快照，可不启用这条能力。[Kubernetes controller](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/docs/kubernetes/index.md)

本次没有验证 OpenSandbox Docker 后端的只读根文件系统、不可信脚本与 execd 的进程权限分离、gVisor/Kata 与 egress 的组合兼容性；这些不能作为已具备的平台保证。

## 超时、取消和故障语义

需要分别定义：排队／准备时限、单条命令时限、整个 sandbox 生存时限、外部业务调用时限。SDK 请求超时或浏览器断开，不等于远端脚本已停止。节点失联时，删除 API 对象也不能证明进程已经退出；应保留“取消待确认”状态，不能立即重试有副作用的调用。[Pod 终止与强制删除](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)

- Docker `stop` 的停止信号和宽限期后强制停止可复用，但平台应在执行主机本地维持到期清理，并在服务恢复后核对遗留容器。这里是平台责任建议，不是 Docker 自带业务 TTL 的声明。[stop](https://docs.docker.com/reference/cli/docker/container/stop/)
- Kubernetes Job `activeDeadlineSeconds` 控制整个 Job 的活动期限；`ttlSecondsAfterFinished` 是完成后的清理期限，两者不可混淆。Job 即使设为单并发／单完成次数也可能重复启动程序，业务工具调用必须有幂等控制；不应把 Job 自动重试当成业务恰好一次执行。[Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[完成后 TTL](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/)
- OpenSandbox 普通 `/command` 有以毫秒计的命令超时，省略则不强制超时；`DELETE /command` 用于中断。另有 sandbox TTL／删除。隔离 session API 又有不同的后台运行超时语义，因此首期应限定使用的 API，不能混搭示例。取消验收应检查后代进程、输出状态和 sandbox 清理，必要时删除整个独占 sandbox。[execd API schema](https://github.com/opensandbox-group/OpenSandbox/blob/c39b814f36ded4c61d5ac6f9332ee4dfbab86c00/specs/execd-api.yaml)

## 建议的下一步验证与决策输入

先验证一个客户侧 Linux 部署样例：固定镜像中的 Node.js／Python／Bash 读取本次输入、调用受控工具入口、生成输出。对 Docker 直接驱动和 OpenSandbox 复用 API 两条路径比较实际适配成本；如果明确首批客户都有 Kubernetes，再加入 Job + RuntimeClass 的同样验证。

验收至少包含：固定镜像重复运行一致性、缺依赖失败、越界文件读写、直连 IP／IPv6／DNS 绕过、未授权工具调用、资源耗尽、取消后子进程、执行主机服务重启后清理、跨运行文件与凭据残留。适配接口可保持为“准备环境、启动、执行、读取状态／输出、取消、销毁”，Mastra 仍负责 Agent／工作流语义；sandbox 服务留在客户执行侧。

待用户／客户输入的是现有主机或 Kubernetes 条件、脚本来源信任程度、是否需要多次命令共享工作目录，以及所需工具的真实协议／端口。本文给出了可复用方案和前提，尚未选定平台生产隔离实现。
