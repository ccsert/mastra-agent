# 自托管统一身份服务：Keycloak、authentik 与 ZITADEL

研究日期：2026-09-07。对应[身份服务候选研究](../../.scratch/agent-platform/issues/22-identity-provider-options.md)，输入为[身份授权基线](../../.scratch/agent-platform/issues/02-tenancy-and-delegation.md)与[讨论方案](../planning/identity-authorization-proposal.md)。本次只读取官方文档、GitHub 发布 API 和固定提交中的源码、许可文件；没有安装、启动或测试身份服务。父目录没有 Git，本次没有初始化仓库或建立研究分支。

文中的“事实”表示官方文档或源码可以支持；“建议／推断”表示针对本平台的设计判断；“待验证”表示尚未通过实际配置、协议请求与浏览器运行确认。

## 结论与首期推荐

**建议以 Keycloak 作为首期自托管身份中心的原型候选，保留 ZITADEL 作为更强调 B2B 组织自助管理时的备选。authentik 可作为客户已有身份源接入；目前不优先承担本平台集中多客户的身份底座。** 这是研究建议，尚未决定采购、生产版本、租户拓扑或部署。

判断依据是：Keycloak 已有默认支持的 Organizations、标准 Token Exchange V2 和 JWT Authorization Grant，且服务端采用 Apache-2.0；ZITADEL 的组织、项目授权和组织级身份源更直接面向 B2B，但当前服务端许可为 AGPL-3.0-only；authentik 的单组织 SSO、协议接入与登录流程能力完整，但其原生多租户功能仍标记 Enterprise 和 alpha，并明确列出跨租户表达式策略边界。[Keycloak 功能状态][K-feature]、[Keycloak 许可][K-license]、[ZITADEL 组织][Z-org]、[ZITADEL 许可范围][Z-licensing]、[authentik 多租户][A-tenancy]。

推荐成立的前提：平台接受运维独立的身份服务与数据库；资源权限、AppID/AK/SK、用户委托信任关系仍由平台接入与授权模块负责；首期不依赖实验性的身份委托功能作为不可替代前提。客户数量、身份规模与高可用目标尚未明确，不能据本研究承诺容量或选择“一租户一个 Realm”的生产拓扑。

## 版本与许可核验

以下为研究当日 GitHub `releases/latest` 返回、`prerelease=false` 的最新发布快照。它说明官方发布标签，不等于全部功能稳定，也不等于镜像、数据库与客户端组合已经验证。

| 产品 | 官方发布与时间（UTC） | 固定源码提交 | 许可文件事实 |
| --- | --- | --- | --- |
| Keycloak | [26.7.3][K-release]，2026-08-31 | `6d238b6558037085cc25c915893c3d301a80243e` | 根 `LICENSE.txt` 为 Apache-2.0；依赖许可另列。[许可][K-license] |
| authentik | [version/2026.8.1][A-release]，2026-09-01 | `b4de7336e903ef51febf42c0ff3b57c484866cdc` | 根许可证按目录区分：通常代码 MIT；`authentik/enterprise/` 使用 EE 许可；网站文档 CC BY-SA 4.0；第三方组件遵循自身许可。[根许可][A-license]、[EE 许可][A-ee] |
| ZITADEL | [v4.17.3][Z-release]，2026-09-04 | `41b11149c6997eddd7e38390912e12ff5f918a73` | 服务端仓库默认 AGPL-3.0-only；`proto/`、`apps/docs/` 为 Apache-2.0；`apps/login/`、指定客户端包为 MIT；官方提供商业许可路径。[许可][Z-license]、[目录例外][Z-licensing] |

authentik 的发布标签为 annotated tag：标签对象 `87f2201d7b66e7a367afc668128b230af7173c83` 指向表中提交；另外两项标签直接指向表中提交。核验来源为三个仓库的发布 API 与标签引用 API；文件链接均固定提交。正式制品仍需固定镜像 digest、数据库版本和前端依赖版本。

许可影响的设计判断：Keycloak 的许可边界更方便本平台按现有商业交付方式评估；ZITADEL 不能继续按早期 Apache 版本的印象判断。这里没有推导“经 OIDC/API 接入就导致整个平台必须公开源码”，也没有给出商业再分发已经合规的结论。若选择 ZITADEL 或 authentik EE，应按实际使用、修改和分发方式核对对应条款。[ZITADEL 官方许可说明][Z-licensing]、[authentik EE 条款][A-ee]。

## 能力比较与平台适配

| 维度 | Keycloak | authentik | ZITADEL |
| --- | --- | --- | --- |
| 自有统一认证中心 | 本地用户、OIDC/SAML、会话与管理能力。[管理文档][K-admin] | 可作为 OIDC Provider，并以登录 Flow 组合认证过程。[OAuth Provider][A-oauth] | 可作为主用户库，并支持标准登录、会话与管理 API。[身份源][Z-idp]、[API][Z-api] |
| 第三方身份接入 | Identity Brokering 接入 OIDC/SAML；User Federation 对接 LDAP 等。[管理文档][K-admin] | Sources 对接 OAuth、SAML、LDAP 等外部用户源，映射用户与组。[Sources][A-sources] | 可在实例或指定组织配置 OIDC/SAML/LDAP 等身份源。[身份源][Z-idp] |
| 多客户身份边界 | Realm 隔离身份域；Organizations 在同一 Realm 内提供 B2B 成员、身份源与组织上下文。[Realm][K-admin]、[组织源码][K-org] | 多租户使用独立 PostgreSQL schema；Enterprise/alpha，不能将 Brand 当租户隔离。[多租户][A-tenancy] | Organization 是内建身份组织边界，支持组织级身份源、配置与项目授权。[组织][Z-org] |
| React/Vite 前后端分离 | 官方 `keycloak-js`，浏览器 public client，Authorization Code + PKCE。[JS Adapter][K-js] | OIDC Provider 支持 PKCE；可用标准 OIDC 客户端接入 React，Vite 不是协议障碍。[OAuth Provider][A-oauth] | 官方 React 示例使用 `react-oidc-context` / `oidc-client-ts` 和 PKCE。[React 示例][Z-react] |
| 应用服务身份 | OIDC client 的 service account，可用 client credentials 或签名断言认证。[服务帐号][K-service] | 支持 M2M、service account、app-password/token 与 JWT 信任等方式；具体请求形态与普通 OAuth client secret 不能混用。[M2M][A-m2m] | 服务帐号支持 private key JWT、client credentials、PAT 等机制。[服务帐号][Z-service] |
| 可信用户委托 | 标准 V2 交换、JWT 授权断言可以作为协议基础；显式 Delegation 功能仍 experimental。[功能状态][K-feature]、[交换][K-exchange]、[JWT Grant][K-jwt] | 2026.8 起文档支持 subject + Actor 的 OBO；Actor 条件、管理方式与 EE 边界需要验证。[交换][A-exchange]、[Agent 帐号][A-agent] | 交换支持 subject/actor 与 `act`；委托和 impersonation 共用权限模型，不能直接等同平台限定用户委托。[交换][Z-exchange] |

以上产品的组织、组、角色和项目命名不自动对应本平台的租户、项目、环境、资源版本与正文访问权限。例如 ZITADEL Project 表示应用安全上下文，不能仅凭名称相同就替代平台的 Agent 项目。建议所有 IdP 声明经过平台的受控映射，再参与平台资源授权；IdP 的管理权限不自动授予客户会话正文权限。

## Keycloak：可优先验证，但要区分三类交换

**事实：**26.7.3 的 `Profile.java` 将 Organizations、Standard Token Exchange V2、JWT Authorization Grant 列为默认功能；Token Exchange Delegation 和 Identity Assertion JWT 列为 experimental，旧 Token Exchange V1 列为 preview。官方文档还将 V1 标为 deprecated。[固定源码][K-feature]、[交换文档][K-exchange]。

| 路径 | 当前证据与边界 | 本平台建议 |
| --- | --- | --- |
| 同 Realm 的 token exchange V2 | 受信 confidential client 交换已有 Keycloak access token，指定目标 audience；默认 scope 处理可能加入客户端允许的额外 scope，不能假设天然只缩权。[交换][K-exchange] | 显式验证允许的 audience/scope，并配置只缩权策略；平台再次检查应用和用户共同的资源范围。 |
| 外部 JWT Authorization Grant | 验证受信 IdP 签名和 `iss/sub/aud/exp` 等；客户端、IdP 均须显式允许；外部 `sub` 要能关联到已链接的 Keycloak 用户；默认一次性断言需要 `jti`。[固定版本文档][K-jwt] | 可验证客户可信后端/身份服务的短期用户断言；先建立受限信任和身份链接，再交换。不能让持 AK/SK 的任意应用自行代表任何用户。 |
| 显式 Delegation / 新跨域 Identity Assertion | 功能状态仍 experimental；Delegation 文档提示不用于生产。[固定功能状态][K-feature]、[Delegation][K-exchange] | 首期产品委托契约不以这些实验功能为必需项，也不启用 deprecated V1 作为默认捷径。 |

**建议／推断：**可信委托可以由平台接入层验证“已认证应用 + 获准身份来源的用户证明”，生成平台自己的受限执行上下文，分别保留发起应用、用户、实际工具执行身份。需要调用接受 OAuth 的下游时，再使用经过验证的 IdP 交换路径。这个平台上下文不是宣称已实现 RFC 8693 Actor 链，二者应分别测试。

**待验证：**无本地密码的外部用户如何预链接或受控建档；断言重放、密钥轮换、停用用户的结果；交换后实际 `sub/azp/aud/scope`；平台审计如何保留业务应用和原始用户来源。Keycloak 的 access-token 交换不提供自动的 access-token 撤销链，原始 token 被撤销不能直接证明后续 token 已无效。[撤销说明][K-exchange]。

租户拓扑建议分两步：原型先用两个 Realm 证明发行者和用户标识不能串用；生产再依据客户规模、登录定制与身份共享要求比较 Realm-per-tenant 和共享 Realm + Organizations。前者提供独立身份域，但有配置与生命周期管理成本；后者减少身份域数量，平台仍须严守资源隔离。这是工程推断，没有完成负载或运维规模验证。[Realm 模型][K-admin]、[Organizations 模型][K-org]。

## authentik：多租户与新 OBO 的具体限制

**事实：**原生 Tenancy 功能标记 Enterprise、alpha；每租户独立 schema、Install ID 和许可证，管理通过 API，embedded outpost 不支持该模式；官方明确指出 expression policies 当前可访问所有租户。[固定版本 Tenancy][A-tenancy]。

**建议／推断：**因此，不以“一个共享 authentik 实例 + 不同 Brand/组”直接兑现本平台客户隔离。若客户已经使用 authentik，可通过标准联邦接入；若将其作为平台底座，需单独验证按客户部署独立实例的成本，或确认并接受其多租户特性的状态与限制。

**事实：**2026.8 的 token exchange 支持 `subject_token` 与 `actor_token`，输出 `act`；Actor 不能直接用普通用户或普通 service account 替代。带 parent 的 Actor 必须对应 subject 用户；无 parent 的 Actor 仅允许相应 OAuth/JWT actor token。Actor token 不能通过外部 OIDC Source 路径验证，代码同样执行这些条件。[交换文档][A-exchange]、[验证源码][A-exchange-code]。

**待验证：**固定版本 `Agent accounts` 管理文档标记 Enterprise，而 OBO 文档及 `Actor` 验证代码位于普通 OAuth/core 路径。不能仅凭 OBO 页面没有 Enterprise 标记就声称所需的完整 Actor 创建、管理和委托生命周期全部免费可交付；需核实具体配置/API 与许可边界。[Agent 帐号文档][A-agent]、[交换源码][A-exchange-code]。

M2M 也要按固定版本验证：文档既介绍 service-account username/app-password 方式，也介绍 provider client-secret 自动生成服务帐号的路径；不能把所有请求都按一个通用 `client_id + client_secret` 假设处理。[M2M 文档][A-m2m]。

## ZITADEL：B2B 模型贴近，但委托仍须平台约束

**事实：**Organization 可承载用户、服务帐号及项目，并可对其他组织授予项目管理范围；客户可使用不同身份源与组织配置。组织名、登录名域设置和实例级默认规则影响帐号的实际唯一性，不能只凭邮箱相同合并外部帐号。[组织文档][Z-org]、[联邦文档][Z-idp]。

**事实：**Token exchange 支持保留 subject 与 actor 的 `act`，但文档在实现上将 delegation/impersonation 归为同类。Actor 需要相应 impersonation 权限，实例或组织范围的 impersonator 角色并不是“这个业务应用只代表本应用获准用户”的完整约束。仅传用户 ID 的方式属于实验扩展；首期不应以此替代可信用户证明。[固定交换文档][Z-exchange]。

**建议／推断：**如果后续客户组织自助配置、租户品牌与跨组织身份管理成为主要交付内容，ZITADEL 值得进入同等原型比较。即使选择它，AppID/AK/SK、资源使用与正文访问、工具实际执行身份、业务用户委托范围依然由平台定义。

## 自托管交付与浏览器接入

| 产品 | 官方部署事实 | 对本平台的影响（建议／待验证） |
| --- | --- | --- |
| Keycloak | 提供容器和服务器发行方式；可配置 PostgreSQL 等关系数据库；生产启动与开发模式区分。[容器][K-container]、[配置][K-config]、[数据库][K-db] | 身份服务放在集中平台侧独立运维；客户 Runtime 支持 Linux 直装，不意味着客户必须同步安装完整 IdP。原型和正式交付均固定版本。 |
| authentik | 官方结构为 server、worker、PostgreSQL；当前架构已不应按旧教程增加必需 Redis。Compose 用于测试和小规模生产；默认 worker 的 Docker socket 挂载用于管理 outpost，可移除改为手动管理。[架构][A-arch]、[Compose][A-compose] | 需要 outpost 才评估相应组件；不能将它自动当作本平台已确定的私网主动连接器。 |
| ZITADEL | 支持 Linux 与容器部署；当前 Compose 包含 API、独立 Login 与 PostgreSQL/反向代理，代理需支持相应 HTTP/2 链路；Redis 为可选缓存。[Linux][Z-linux]、[Compose][Z-compose]、[要求][Z-requirements] | 官方 Login 使用 Next.js 不要求本平台 React/Vite 控制台换框架；需额外维护登录组件、初始化与升级流程。官方 Linux 最小部署示例不等于完整生产安装包。 |

React/Vite 可通过标准跳转式登录与 IdP 解耦。浏览器 public client 不保存 client secret、SK 或 IdP 管理凭据；直接 SPA 可以用 PKCE，平台也可评估 BFF 保管会话。二者的实际安全与兼容配置尚未测试。[Keycloak 浏览器要求][K-js]、[authentik OAuth][A-oauth]、[ZITADEL React][Z-react]。

对于 iframe，不应把可嵌入业务 UI 与“IdP 登录页可在第三方 iframe 静默 SSO”混为同一能力。Keycloak 官方说明第三方 Cookie 限制会影响 silent SSO 与登出检测。建议宿主业务后端完成受信身份交换，嵌入组件使用绑定应用、用户、来源与用途的短期平台会话；具体握手和续期由 API/UI 接入契约验证。[浏览器限制][K-js]。

## 平台仍需实现的边界

以下为基于已确定产品要求提出的设计分工，不是上述产品的现成能力清单。

1. **AppID/AK/SK**：AppID 定位业务应用；AK 标识具体凭据，SK 参与所选应用验证协议。是否采用请求签名或交换短期 token，由接入协议确定；不把平台 AK/SK 直接改名成 OAuth client ID/secret。OAuth client 可以与业务应用建立显式映射，轮换与停用语义分别处理。
2. **主体映射**：记录受信发行者和稳定 subject；内部平台主体与外部身份链接分开。建档不自动入项目，不按邮箱相同静默合并帐号。
3. **应用与用户共同授权**：应用自身任务使用服务权限；用户委托必须有获准的身份来源、用户证明与应用委托范围。平台不能只验证签名后就接受任意 `tenantId/userId`。
4. **资源与正文授权**：租户、项目、环境、已发布能力、会话入口及正文权限由平台检查。共享 Agent 不等于读取其所有会话；身份中心管理员不因此获得客户文档或工具结果。
5. **执行上下文与撤销**：Runtime/连接器有独立执行方身份；运行快照、在线校验、缓存和失效时限需落实已停用应用、离职用户和撤销授权的行为，不能只依赖长效 JWT。
6. **工具身份**：平台证明了调用用户，也不能证明订单系统已接受该用户。须显式选择服务帐号或下游接受的用户委托凭据，并记录实际执行主体。

## 最小验证清单

建议先围绕 Keycloak 做一个隔离的协议原型，再决定是否需要与 ZITADEL 做同场对比。以下均为待完成验证，本次没有执行。

| 验证 | 必须观察到的行为与证据 |
| --- | --- |
| 版本与部署 | 固定服务镜像 digest、数据库、客户端版本和启用特性；容器健康与重启后身份配置保持。实验功能是否关闭可以检查。 |
| 平台登录 | React/Vite 完成 Code + PKCE、刷新、退出；后端拒绝错误 issuer/audience、过期 token；浏览器包中无 SK/client secret。 |
| 外部身份联邦 | 两个客户身份源分别登录；相同邮箱、同名用户不会跨来源误链接；停用与再启用行为有记录。 |
| 两客户隔离 | A 的用户或 service account 修改请求中的租户、Realm、资源标识，仍不能读取 B 的资源和正文。 |
| 应用自身任务 | 应用凭据换发受限服务上下文，审计主体是应用；不创建伪造的人类用户。轮换一个凭据不改变应用主体归属。 |
| 可信用户委托 | 已允许应用 + 受信用户证明通过；伪造 userId、未授权身份来源、错误 audience、过期及重复断言被拒绝；审计同时保留应用和用户。 |
| Token exchange | 输出的 audience/scope 不超出平台契约；输入 token 无权面向交换客户端时拒绝；不把 `azp` 当完整原始调用链。 |
| 权限交集 | 用户只能读取区域 A、应用只能调用订单查询时，委托不会获得区域 B 或写订单的权限。下游工具同样执行范围约束。 |
| 管理与正文 | 租户/项目配置管理员、平台运营没有内容授权时均无法读取他人正文；获准内容审阅可长期生效并可撤销。 |
| 入口隔离 | 平台、订单系统和客服系统默认会话隔离；拿到另一入口会话 ID 不能读取；显式授权后按查看/继续/下载分别生效。 |
| iframe 与 SDK | 在允许和阻止第三方 Cookie 的浏览器环境验证登录、握手、来源校验、过期续期、退出；不依赖静默 iframe SSO 才能使用。 |
| 生命周期 | 删除应用凭据、停用用户、撤销项目成员与内容权限后，已发 token、活动会话、运行中任务分别按明确时限失效；重启恢复不扩大权限。 |

交付证据至少包含匿名化配置、协议请求/响应、实际 claims、拒绝案例、审计记录和浏览器结果。通过这些检查只说明所测组合可用；高可用、升级回退、备份恢复及容量承诺仍需独立验证。

## 官方来源索引

固定提交链接用于追溯本次证据；未固定版本的官网页面为研究当日读取的滚动文档。没有引用社区比较文章或将其作为结论依据。

[K-release]: https://github.com/keycloak/keycloak/releases/tag/26.7.3
[K-license]: https://github.com/keycloak/keycloak/blob/6d238b6558037085cc25c915893c3d301a80243e/LICENSE.txt
[K-feature]: https://github.com/keycloak/keycloak/blob/6d238b6558037085cc25c915893c3d301a80243e/common/src/main/java/org/keycloak/common/Profile.java
[K-admin]: https://www.keycloak.org/docs/latest/server_admin/index.html
[K-org]: https://github.com/keycloak/keycloak/blob/6d238b6558037085cc25c915893c3d301a80243e/docs/documentation/server_admin/topics/organizations/intro.adoc
[K-service]: https://github.com/keycloak/keycloak/blob/6d238b6558037085cc25c915893c3d301a80243e/docs/documentation/server_admin/topics/clients/oidc/proc-using-a-service-account.adoc
[K-exchange]: https://www.keycloak.org/securing-apps/token-exchange
[K-jwt]: https://github.com/keycloak/keycloak/blob/6d238b6558037085cc25c915893c3d301a80243e/docs/guides/securing-apps/jwt-authorization-grant.adoc
[K-js]: https://www.keycloak.org/securing-apps/javascript-adapter
[K-container]: https://www.keycloak.org/server/containers
[K-config]: https://www.keycloak.org/server/configuration
[K-db]: https://www.keycloak.org/server/db
[A-release]: https://github.com/goauthentik/authentik/releases/tag/version/2026.8.1
[A-license]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/LICENSE
[A-ee]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/authentik/enterprise/LICENSE
[A-tenancy]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/sys-mgmt/tenancy.md
[A-oauth]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/add-secure-apps/providers/oauth2/index.mdx
[A-sources]: https://docs.goauthentik.io/users-sources/sources/index.html
[A-m2m]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/add-secure-apps/providers/oauth2/machine_to_machine.mdx
[A-exchange]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/add-secure-apps/providers/oauth2/token_exchange.md
[A-exchange-code]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/authentik/providers/oauth2/token/token_exchange.py
[A-agent]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/users-sources/user/account-types/agent-accounts.md
[A-arch]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/core/architecture.md
[A-compose]: https://github.com/goauthentik/authentik/blob/b4de7336e903ef51febf42c0ff3b57c484866cdc/website/docs/install-config/install/docker-compose.mdx
[Z-release]: https://github.com/zitadel/zitadel/releases/tag/v4.17.3
[Z-license]: https://github.com/zitadel/zitadel/blob/41b11149c6997eddd7e38390912e12ff5f918a73/LICENSE
[Z-licensing]: https://github.com/zitadel/zitadel/blob/41b11149c6997eddd7e38390912e12ff5f918a73/LICENSING.md
[Z-org]: https://github.com/zitadel/zitadel/blob/41b11149c6997eddd7e38390912e12ff5f918a73/apps/docs/content/guides/manage/console/organizations-overview.mdx
[Z-idp]: https://zitadel.com/docs/guides/integrate/identity-providers/introduction
[Z-api]: https://zitadel.com/docs/apis/introduction
[Z-react]: https://zitadel.com/docs/sdk-examples/react
[Z-service]: https://zitadel.com/docs/guides/integrate/zitadel-apis/access-zitadel-apis
[Z-exchange]: https://github.com/zitadel/zitadel/blob/41b11149c6997eddd7e38390912e12ff5f918a73/apps/docs/content/guides/integrate/token-exchange.mdx
[Z-linux]: https://zitadel.com/docs/self-hosting/deploy/linux
[Z-compose]: https://zitadel.com/docs/self-hosting/deploy/compose
[Z-requirements]: https://zitadel.com/docs/self-hosting/manage/requirements
