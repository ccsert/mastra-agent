# 企业 Agent 平台

面向业务团队的 Agent、知识库、工具/MCP、标准 Agent Skills 和工作流平台。支持平台内直接使用，以及 OpenAPI、生成 SDK、React 组件和 iframe 接入。集中控制面与 Runtime 分离，资源可由平台托管、客户私有部署或在同一项目中混合使用。

当前处于架构决策与技术原型阶段，尚无完整平台应用或生产部署。平台父目录未初始化 Git；Skill 原型和工作流研究以独立实验仓库保存。

## 主线与入口

- **执行与编排**：Mastra 执行 Agent/工作流，FlowGram 编辑和 AI 修改流程；不引入 FlowGram 第二套后端执行引擎。[编排 ADR](docs/adr/0001-flowgram-authoring-mastra-execution.md)
- **界面与集成**：React + Vite，assistant-ui 为聊天基础，Ant Design 6 为后台界面候选；公开 API SDK 采用生成路线。[聊天 ADR](docs/adr/0002-assistant-ui-chat-foundation.md)
- **决策索引**：[架构决策地图](.scratch/agent-platform/map.md)，其中的票据记录已确定行为、研究依据和待验证事项。
- **统一词汇**：[领域术语](CONTEXT.md)。完整讨论背景见[架构草案](docs/planning/agent-platform-discovery.md)。

## 已有运行证据

[Skill 原型报告](docs/research/skill-sandbox-prototype-2026-09-07.md)记录 Mastra 1.64.0 + Docker Linux/arm64 的 18 组通过检查：固定版本读取/执行、Node/Python/Bash、工具入口与准入范围、只读与禁网、两租户并发、预算、超时/取消及清理。最后一轮脚本实验创建的 14 个容器与各次工作目录已清理。

原生 VersionedSkillSource 信任 blob store 返回内容；平台增加摘要校验后，损坏内容在读取和执行前被拒绝。该发现已有确定性实验，不能仅凭内容寻址的接口名称省略验证。

原型位于[独立实验目录](.scratch/agent-platform/labs/skill-sandbox/README.md)，分支 `prototype/skill-sandbox`。保存了[完整 JSON 证据](.scratch/agent-platform/labs/skill-sandbox/evidence/latest.json)和[可展开的证据页面](.scratch/agent-platform/labs/skill-sandbox/report.html)。依赖和镜像准备后，执行 `pnpm verify` 可复跑。

这些结果不证明生产多租户隔离、客户 Linux 原生安装、许可目标联网、上传 ZIP 导入、持久化产物或完整业务闭环已经完成。证据页的浏览器预览受 URL 策略限制；CLI 实验和源码摘要已核对。

[工作流持久化实验](docs/research/workflow-persistence-probe-2026-09-07.md)使用 Mastra 1.64.0 + libsql 1.22.3，在 24 个独立 Node 进程中完成 10 项断言：挂起恢复、版本覆盖与固定、依赖缺失、并发恢复和业务写入后崩溃。旧运行恢复时会使用当前装配的图和工具，平台须固定版本与实现；无业务幂等时，写入后崩溃会造成重试后的重复效果。实验也确认框架已有 resume 并发状态保护。

完整[代码与证据](.scratch/agent-platform/research/workflow-persistence/README.md)可用 `pnpm verify` 复跑。本地文件数据库结果不替代正式持久化适配器、Linux、多节点接管或最终恢复契约的验收。

[发布契约实验](docs/research/release-contract-probe-2026-09-07.md)完成 42 项检查，实际执行固定 Tool/mapping/子工作流：布局变化保留执行摘要，依赖变化形成新发布；无效变量、目录越权、篡改发布和撤销后调用被拒绝。[代码、实验 schema 和示例草稿](.scratch/agent-platform/research/release-contract/README.md)可复跑；该实验本身未接入真实 AI、正式身份或发布激活事务；实际画布往返由下面的后续实验补证。

[FlowGram 实际往返实验](docs/research/flowgram-roundtrip-probe-2026-09-07.md)完成 21 项适配器检查、17 项真实编辑器检查和 10 项交互检查（覆盖有交集）。根/子流程经过编辑器后保持固定执行含义；工具 v2 修改、保存及跨流程切换后实际输出 240，拖动与撤销保持执行摘要。完整替换、纯 data 字段历史及 1.0.15 的位移服务差异已明确；表单、变量和真实 AI 仍待验证。[实验入口与截图](.scratch/agent-platform/research/flowgram-roundtrip/README.md)可复核。

## 首期验收与当前方案

用户已选择[通用合成验收样例](docs/planning/first-release-acceptance-proposal.md)：文档入库、知识库检索、订单查询与报表，分别覆盖独立 Agent、知识库和工作流，再验证平台与各嵌入入口。容量先实测，客户目标后补。

| 主题 | 当前资料与状态 |
| --- | --- |
| 身份与资源权限 | [身份授权方案](docs/planning/identity-authorization-proposal.md)：租户/项目/环境、应用服务身份与可信用户委托已确定 |
| 身份中心 | [交付方案](docs/planning/identity-center-delivery-proposal.md)与[候选研究](docs/research/identity-provider-options-2026-09-07.md)：推荐 Keycloak 原型，具体交付范围正在收敛 |
| 工具与 MCP | [治理方案](docs/planning/tool-mcp-governance-proposal.md)：用户采用写入默认确认，可按版本/动作/业务对象范围预先授权自动执行 |
| 内容策略 | [生命周期方案](docs/planning/content-policy-lifecycle-proposal.md)：用户选择撤销许可和副本删除分别处理，保留模板仍在收敛 |
| 部署与 Skill | [部署方案](docs/planning/runtime-deployment-profiles.md)与[运行架构](docs/planning/skill-runtime-architecture.md)：Docker 为主，保留 Linux 直接安装，首轮实验已完成 |
| AI 编排 | [编排方案](docs/planning/ai-workflow-authoring-proposal.md)与[官方构建器研究](docs/research/mastra-workflow-builder-2026-09-07.md)：22 项确定性 SDK 发现；局部 FlowGram 往返已实测，完整生成、表单与变量仍待验证 |
| Runtime 恢复 | [契约草案](docs/planning/runtime-recovery-contract-proposal.md)：受理、离线许可、执行归属、取消与不确定写入已具体化；离线续行和首期接管范围待选择 |
| 发布与版本 | [发布方案](docs/planning/publication-and-version-pinning-proposal.md)与[42 项契约检查](docs/research/release-contract-probe-2026-09-07.md)：基础清单已有可运行证据，正式激活、回滚与保留模板待收敛 |

构建器和持久化事实调查已完成；完整恢复原型、主动连接和聊天/SDK 接入按决策依赖继续推进。各文档明确区分产品基线、设计建议、研究结果与已运行验证，不将研究完成视为功能交付。
