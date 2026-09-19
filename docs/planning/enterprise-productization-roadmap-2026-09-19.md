# 企业化产品化路线 · 2026-09-19

面向"可交付给企业客户运营"的目标，盘点身份、成员与项目管理的产品化差距，并给出分阶段交付顺序。现状与缺口的事实依据见文末引用；本路线不改变既有架构决策，只排定落地顺序。

## 现状基线（已交付）

- 账号：初始化建租户 + 唯一 owner、用户名密码登录、邀请链接加入（哈希存储、3 天有效、可撤销）；登录/认证接口限流。
- 成员与授权：租户角色 owner/admin/member；项目角色 admin/editor/member/viewer 与 8 项权限；成员启停、撤销会话、所有权移交；租户与项目两级操作审计。
- 项目：创建、列表；项目即资源（模型/工具/Agent/会话/运行）的隔离边界。
- 本轮新增（2026-09-19）：自助修改密码（改密即退出其他设备会话）、自助"退出其他设备"、项目重命名与说明修改、项目归档/恢复（归档在授权层集中冻结写入与执行，应用接入一并拒绝）。

## 阶段一：账号安全与项目生命周期（本轮，已实现）

解决"日常运营最高频、且不依赖外部系统"的缺口：

1. 账号自助安全：改密（校验旧密码、密码策略与注册一致、同事务撤销其他会话并写审计）；退出其他设备。会话可见性（设备/IP/时间列表）需要 sessions 表扩展，放到阶段二。
2. 项目生命周期：改名、说明、归档、恢复。归档语义 = 项目可读、写入与执行冻结（`Access.scope` 对归档项目剥离写权限，`project-authorization` 的所有写路由统一 403 `PROJECT_ARCHIVED`），应用凭据仅保留 `project.read`；审计记录归档/恢复。

## 阶段二：会话治理与审计可用性

1. 会话可见与自助管理：sessions 表增加 id、created_at、last_seen_at、user_agent、ip（迁移），提供"我的会话"列表与单条撤销；管理员视角沿用现有成员撤销。
2. 审计可用性：`access_audit` 列表分页（当前硬编码最近 100 条）、按操作者/动作/时间过滤、CSV 导出；补充业务资源变更的审计覆盖（当前仅成员/邀请/发布类动作）。
3. 登录防爆破多实例化：限流状态从进程内存迁到共享存储（DB 或 Redis），配合失败锁定与告警。
4. 归档深化：归档项目的已建立 SSE 与进行中会话的显式中断/提示；删除决策保持"不提供物理删除，仅归档"，待配额与备份策略就绪后重评。

## 阶段三：身份联邦与规模化

按既有提案推进，不自研：

1. 身份中心：以 Keycloak 为原型候选（ZITADEL 备选）打通 OIDC 登录，密码本地存储逐步退役为可选路径（identity-center-delivery-proposal）。
2. 授权细化与映射：外部身份角色到平台项目角色的映射、自定义角色（identity-authorization-proposal 中"尚未实现"项）。
3. 租户/项目/环境三层：环境（test/prod）作为项目下资源边界与授权目标（first-release-acceptance-proposal 的双环境验收前提）。
4. 配额与计费口径、SCIM 目录同步、跨租户运营面板（platform-workbench-design），随客户合同需求排期。

## 明确不做 / 暂缓

- 自助开放注册：企业场景保持邀请制；`users.username` 全局唯一跨租户的限制在本阶段保留，租户内唯一语义待身份中心阶段一并处理。
- 平台物理删除项目/租户：先归档，等审计、备份与恢复策略完整后再评估。

## 事实依据

- 现状交付：docs/research/team-access-and-agent-workspace-delivery-2026-09-13.md（成员、邀请、审计与"未做"清单）。
- 身份与授权规划：docs/planning/identity-center-delivery-proposal.md、identity-authorization-proposal.md（Keycloak 路线、自定义角色未实现、环境层基线）。
- 验收口径：docs/planning/first-release-acceptance-proposal.md（双租户/双环境/双认证模式验收）。
- 运营面板设计项：docs/planning/platform-workbench-design.md。
