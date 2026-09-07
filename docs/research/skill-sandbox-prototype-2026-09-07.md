# Skill 版本内容源与 Docker 沙箱：首轮运行证据

日期：2026-09-07。对应[Skill 沙箱原型](../../.scratch/agent-platform/issues/18-skill-sandbox-prototype.md)。本轮已运行真实 Mastra 发布包和 Docker 容器，18 组检查通过；验证范围是本机 Docker Desktop Linux/arm64 的固定入口与基础隔离，不是客户 Linux 或平台生产验收。

## 结论

**Mastra 版本内容源 + 平台受限脚本工具 + Docker 隔离执行这条适配路径可行，可以继续做有网络工具和跨运行域的验证。** Node.js、Python、Bash 均能从同一固定 Skill 版本读取并执行，容器可落实本轮测试的文件、网络、内存和输出限制。

有一项需要写入实现契约：`@mastra/core@1.64.0` 的 `VersionedSkillSource` 按 blob hash 取回内容后直接返回，不重算摘要。本轮故意让 blob store 在原 hash 下返回损坏内容，原生 source 确实返回了损坏正文；平台校验包装和执行物化随后均拒绝同一份损坏内容。内容寻址存储的接口约定不能代替读出后的完整性校验。此结论针对该版本与给定异常存储实验，不推导所有 Mastra 存储实现存在相同故障。

## 固定环境与复现

| 项目 | 本轮实际值 |
| --- | --- |
| Mastra | `@mastra/core@1.64.0`；发布包及 pnpm 锁文件，安装禁用生命周期脚本 |
| Schema | `zod@4.5.4` |
| 宿主 | macOS/arm64；Node.js `24.13.0`；pnpm `10.32.1` |
| Docker | Desktop `4.87.0`；Engine `29.7.2`；Linux/arm64，内核 `7.0.12-linuxkit` |
| 基镜像 | `node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` |
| 实际执行镜像 ID | `sha256:0e0ad8c4ee386fcc3a1a9108d0f924912a714d2d09499936a98afb9b5f0795cb` |
| 镜像内解释器 | Node.js `24.20.0`、Python `3.11.2`、Bash `5.2.15` |
| 默认实验限制 | UID/GID 1000；128 MiB 内存及无额外 swap；0.5 CPU；64 PIDs；32 MiB 输出 tmpfs；16 MiB 临时目录；32 KiB stdout/stderr 捕获预算 |

宿主 Node 与容器 Node 是不同执行角色，因此分别记录。Python 的 Debian 安装包修订及全部包清单保存在证据中。构建使用当时的 Debian 仓库，未证明未来可重建相同镜像；本轮每次执行都使用已经固定的镜像 ID。

复现入口为[独立实验目录](../../.scratch/agent-platform/labs/skill-sandbox/README.md)。准备依赖和镜像后运行 `pnpm verify`。完整证据位于 [latest.json](../../.scratch/agent-platform/labs/skill-sandbox/evidence/latest.json)，包含每个检查、调用 ID、容器限制、退出原因、清理结果、代码与锁文件摘要。原型没有注册业务应用、部署身份服务或调用真实客户接口。

## 已观察到的行为

| 检查组 | 实际证据 | 能支持的结论 |
| --- | --- | --- |
| 版本读取与发现 | Workspace 发现指定 `report-skill`；v1/v2 分别返回自己的正文；不存在的版本文件和其他目录读取失败 | 版本源适配可用，未配置 live fallback |
| 摘要破坏 | 原生 source 返回人为损坏内容，平台读取与物化报 `CONTENT_INTEGRITY`；容器未创建 | 需要由平台或存储适配层保证内容完整性 |
| 最终工具装配 | `Agent.getToolsForExecution()` 返回 `skill`、`skill_read`、`skill_search`、`run_skill_script` | 本配置未注入任意命令和通用文件写入工具；没有真实模型调用 |
| 参数与准入 | command/cwd/env/version 额外字段、越权入口、租户/项目/环境/应用不匹配、错文件引用、过期或撤销授权均在创建容器前拒绝 | 受限工具入口和模拟授权记录可以落实准入边界；未证明真实身份链 |
| 三种语言 | Node/Python/Bash 均对合成订单得到数量 2、总额 42；输出含绑定版本和所属客户 | 解释器、固定路径与 JSON 文件输入可用 |
| 发布后旧任务 | 同时执行 v1/v2，分别输出 `VERSION_ONE`/`VERSION_TWO` | 创建新版本不改变已绑定版本的读取与执行 |
| 文件与凭据 | 包、输入、根目录写入为 `EROFS`；未挂载的宿主合成文件、其他文件与 Docker socket 为 `ENOENT`；宿主合成环境凭据未进入容器 | 本轮挂载与环境边界生效 |
| 禁用网络 | Docker network 为 none；仅 loopback 有地址，无 IPv4 路由；测试地址连接返回 `ENETUNREACH` | 全禁网络有效；不能推导选择性目标放行已经完成 |
| 基础进程限制 | UID 1000，CapEff 为 0，NoNewPrivs 为 1，Seccomp 为 2；容器内读取到预期 cgroup 上限 | 设置实际生效；CPU 和 PIDs 未进行压力测量 |
| 实际预算触发 | 40 MiB 输出写入 32 MiB tmpfs 返回 `ENOSPC`；stdout 超预算后终止且捕获不超过 32 KiB；内存实验 `OOMKilled=true`、exit 137 | 内存、工作区输出和捕获预算触发有效 |
| 缺少依赖 | Python 返回 `ModuleNotFoundError` 与 exit 1，根目录只读且网络关闭 | 不会通过该路径运行中自动安装依赖；应显示环境不兼容 |
| 两租户并发 | 两个独立容器只看到自己的输入和输出，结果分别属于 customer-a/customer-b | 本原型挂载不共享可写工作区；不是生产跨租户安全认证 |
| 超时与取消 | 结束前 `docker top` 同时看到 Node、Bash、sleep；结束后 Running=false、PID=0、exit 137；随后删除容器 | 所测后代进程随容器结束，未仅终止客户端等待 |
| 清理与后续调用 | 各次已创建容器均删除，运行目录清空；随后报表调用成功 | 正常控制路径能清理，本轮未观察到工作区污染 |

18 组检查按以上行为组合，精确分组以 JSON 中的 `checks` 为准。生成报告写入的是短暂输出目录；生产产物登记、传输、逐文件授权和下载均不在本轮实现内。

Docker 的 digest、只读挂载、网络和资源选项可在[官方容器运行文档](https://docs.docker.com/engine/containers/run/)核对；上表的通过与否来自实际证据，不仅是配置存在。

## 第一轮失败如何处理

保留的[初次证据](../../.scratch/agent-platform/labs/skill-sandbox/evidence/initial-assumptions.json)为 14 通过、4 失败。两组失败来自“禁用网络时 sysfs 只列出 lo”的假设：该 Linux 内核还暴露了没有可用地址的隧道设备。检查改为读取实际地址、路由及连接结果，未改变网络配置。

另两组失败来自把 Linux 的进程显示名预设为 `node`；本机显示 `MainThread`。改为采集完整命令行，确认进程树中实际运行的 Node 脚本、Bash 与 sleep，再检查容器退出与清理。没有移除子进程验证。修正后的同一套 18 组实验全部通过。

## 尚未证明与后续工作

1. **工具网络通道**：需要在工具/MCP、内容传输与恢复契约收敛后，验证许可目标可达、其他目标拒绝、凭据代理、跨位置结果过滤和断线行为。网络全禁只是本轮受控基线。
2. **标准包导入**：本轮直接读取受控标准目录。ZIP 路径穿越、符号链接、压缩炸弹、签名、二进制文件及包大小限制需要单独实现和验证，不能由正常目录测试替代。
3. **生命周期与撤销**：当前只验证准入时的固定模拟授权，未验证运行中撤销、策略分发、租约、离线许可和控制面不可用。
4. **产物与业务副作用**：未做持久化、下载权限、外部写入幂等和取消后结果核对。取消脚本不意味着已发生的订单写入被回滚。
5. **交付与隔离强度**：客户 Linux 发行版、amd64/arm64 支持矩阵、无 Docker 原生沙箱、gVisor/Kata 等更强隔离、高并发和故障恢复仍需对应环境证据。Docker daemon 属于可信管理边界；脚本不接触 daemon。

因此[原型票据](../../.scratch/agent-platform/issues/18-skill-sandbox-prototype.md)暂不整体关闭。首轮结果已足够支持继续沿当前适配边界推进，但不能宣称 Skill 沙箱及客户交付全部验收完成。
