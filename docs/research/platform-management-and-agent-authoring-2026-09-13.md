# 平台管理、Skill 来源、知识库与 Agent 定义体验审阅

日期：2026-09-13。范围：当前本地代码与 `127.0.0.1:5179` 的实际界面，结合 Agent Skills 与 skills.sh 官方文档。

本轮完成现状核查和改造方案；没有实现或发布下述新功能。当前工作区包含大量前序未提交改动，检查对象是工作区文件，不能用 HEAD `6a2ff15` 代表这次界面版本。聊天与轨迹暂时维持当前范围。

## 结论与顺序

| 顺序 | 方向 | 当前基础 | 下一次交付重点 |
| --- | --- | --- | --- |
| 1 | 成员与权限 | 账号登录、租户边界、应用身份、个人会话范围 | 租户成员、项目成员、角色授权、禁用与会话撤销、操作审计 |
| 2 | Agent 定义工作区 | 草稿、发布快照、模型/工具/知识/Skill/运行配置 | 独立工作区、用途引导、配置分组、草稿试用、发布前变更摘要 |
| 3 | Skill 多来源导入 | 标准 ZIP 校验、版本去重、文件预览、脚本入口授权 | 链接/仓库解析、多 Skill 选择、兼容性说明、来源与版本追踪 |
| 4 | 知识库资料管理 | TXT/Markdown 入库、分段、向量召回、重排、检索测试 | PDF/DOCX、原文定位、文档更新、处理进度与失败修复 |

建议下一阶段包含 1 和 2：先确定并实现项目授权契约，再让新的 Agent 工作区消费真实权限。后续 Skill 与知识库沿用同一套授权和配置入口。

## 本轮界面证据

以下截图在本轮从独立审阅标签页捕获并逐张查看。未改动用户原有聊天标签页，未上传文件、保存 Agent 或点击发布。截图保存在本地 `.scratch/platform-audit-20260913/`，是本机审阅附件。

1. **已查看：Agent 列表。** 每张卡片同时放置编辑、发布、对话；显示已发布版本，但没有清楚提示草稿相对发布版本的差异。模型、能力摘要来自草稿，对话入口使用发布版本，用户难以判断当前配置是否已生效。

   ![Agent 列表](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/01-agents.png)

2. **已查看：创建 Agent 首屏。** 右侧抽屉承载整个创建流程，长指令输入占据主要空间，能力配置位于下方。右侧概览仅显示数量和部分设置，无法验证实际效果。

   ![Agent 创建首屏](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/02-agent-create.png)

3. **已查看：运行配置。** 多个预算、计划、工作区、子代理选项纵向排列，任务档位夹在细项中间。用户需要先理解底层参数才能判断该怎么配置。保存后必须返回列表发布，再新建会话试用。

   ![Agent 运行配置](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/03-agent-runtime.png)

4. **已查看：Skill 导入。** 仅支持单 Skill ZIP，上传区域占据大部分抽屉，结构说明被推到下方。缺少链接输入、来源发现、多个 Skill 选择与导入前内容预览。

   ![Skill 导入](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/04-skill-import.png)

5. **已查看：知识文档。** 已有文档列表、可检索状态和分段入口，当前项目有 3 份可检索文档。支持范围明确为 TXT/Markdown；没有原文阅读、版本更新入口。模型维度等技术信息的视觉位置比资料管理信息更突出。

   ![知识文档管理](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/05-knowledge-documents.png)

6. **已查看：检索测试入口。** 能输入问题和选择返回片段数量；本轮只切换标签，没有发送模型请求。后续应将命中片段与原文位置连起来，并解释未命中的原因。

   ![知识检索测试](/Users/ccsert/project/ai-project/mastra-agent/.scratch/platform-audit-20260913/06-knowledge-search.png)

可见的可访问性风险：步骤 2、3、4 的说明文字偏浅、长内容需要滚动；步骤 5 的状态颜色偏淡，但同时有文字，并非仅靠颜色表达状态。本轮未测量对比度、未完成键盘/读屏与小屏验收，因此不作完整可访问性合格结论。

## 1. 系统管理：从单一管理身份进入团队协作

当前 `Identity.setup()` 只初始化第一个用户与租户，身份接口提供初始化、登录、注销和当前用户。`Principal` 没有角色或成员信息。项目查询对平台用户主要按 `tenant_id` 限定；`requireUser()` 区分平台用户与应用身份，没有项目角色判断。

这意味着已有租户与应用边界，但尚无团队协作所需的成员授权层。左下角“项目管理员”目前是固定文案，不能代表实际角色。个人会话仍按 `actor_id + entry` 隔离，新增管理员角色不应默认允许读取所有人的对话正文。

建议第一版采用固定角色，暂不建设任意组合的自定义权限编辑器：

- **租户设置**：所有者、管理员、成员；管理成员邀请、账号状态、项目创建权限。平台运营身份与租户管理员保持独立概念。
- **项目设置**：管理员、编辑者、使用者、只读成员。分别明确成员管理、资源编辑、发布、调用和只读范围。
- **敏感能力独立判断**：发布 Agent、管理模型/工具凭据、授权 Skill 脚本、导出知识资料不直接等同于“能编辑页面”。
- **完整生命周期**：邀请加入、变更角色、移除项目成员、禁用账号、撤销登录会话、记录操作者与变更。所有者移交和最后一名管理员保护在迁移时一起考虑。
- **统一后端授权**：资源列表、详情、修改、发布、运行、事件流和附件访问使用一致范围；界面显示后端返回的有效能力与真实角色。

入口建议为全局“团队设置”和项目内“项目设置”，避免把系统成员管理混入 Agent 配置页面。

验收：以至少 3 种角色、2 个项目检查实际 API；编辑者不能越权发布或管理成员，使用者可以调用已发布 Agent，越项目访问被拒绝，角色撤销后的新请求不再沿用旧权限，初始化管理员迁移后仍可管理系统。

代码依据：

- [身份初始化与会话](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/identity/identity.ts:8)
- [项目范围检查](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/projects/projects.ts:7)
- [界面固定角色文案](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/app/ProjectConsole.tsx:118)
- [个人会话范围](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/conversations/conversations.ts:107)

## 2. Agent 定义：围绕配置、验证和发布组织页面

对应证据步骤 1—3。核心问题是信息层级和流程断开。当前能力越来越多，继续给抽屉增加字段会进一步提高理解成本。

建议改成独立工作区：

| 区域 | 内容 |
| --- | --- |
| 顶部 | Agent 名称、草稿状态、当前发布版本；保存、试用、发布 |
| 左侧配置导航 | 用途与指令、知识与技能、工具、运行设置、发布记录 |
| 中间编辑区 | 只展示当前分组内容；资源选择包含用途、可用状态与版本说明 |
| 右侧试用区 | 草稿对话、当前配置版本、调用到的能力与结果；可收起，小屏切换为单独标签 |

创建第一步先回答“帮助谁、完成什么、怎样算完成”，提供知识问答、业务执行、复杂任务等起点，允许从空白开始。模型使用可解释的项目默认值；预算细项收进高级设置，常用任务档位放在前面，调整后清楚标为自定义。

在选择位置解释三种资源：知识库提供资料，Skill 提供方法与可复用指令，工具执行具体动作。已选项显示名称、用途和状态，数量作为补充信息。

草稿试用需要后端支持：为某个草稿修订生成固定的调试快照，经授权和依赖检查后启动试用会话，沿用现有执行、用量与轨迹机制。调试快照不改变正式发布版本，业务应用不能把它当作正式发布调用。每次试用明确显示所用修订，编辑后标记“配置已变化，需要重新试用”。

发布前展示相对上次发布的变更、模型与能力兼容性、引用的 Skill 版本和有效授权。发布完成后标明新会话所用版本，并解释已有会话继续使用原版本。版本记录提供变更摘要；回退采用基于历史配置创建新发布的方式保留审计。

验收：新用户能从用途出发创建 Agent、绑定一项知识或 Skill、直接试用草稿、查看工具结果、发布并确认正式会话使用哪个版本。未发布的修改不会让卡片产生“已经生效”的误解。桌面和较窄窗口均可完成该流程。

代码依据：[当前编辑器](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/features/agents/AgentEditor.tsx:58)、[列表发布与创建会话](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/features/agents/Agents.tsx:35)、[现有发布接口](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/agents/routes.ts:61)。

## 3. Skill：统一导入流程，按来源适配

对应证据步骤 4。现有标准解析、内容摘要、版本去重、文件预览与脚本授权值得保留。多平台应复用这些能力，在前面增加来源发现和内容获取。

建议流程：**粘贴链接或上传 → 识别来源 → 扫描 Skill → 选择 → 预览与兼容性检查 → 导入固定版本 → 绑定 Agent**。

第一批接入 skills.sh 链接、公开 GitHub/GitLab 仓库和现有 ZIP。仓库可能含多个 `SKILL.md`，需要展示候选列表与子目录，不能将整个仓库直接视为一个 Skill。私有 Git 凭据和企业目录接入可在后续扩展。

版本增加来源类型、来源地址、请求的 ref、解析后的 commit、Skill 子目录与内容摘要。检查上游更新时展示差异并导入新版本，已发布 Agent 的绑定保持固定。

兼容性结果应区分：标准指令可读取、平台扩展字段需处理、脚本执行所需环境、工具或网络依赖尚不支持。现有解析器对 frontmatter 使用严格字段校验，因此外部包的额外字段需要明确处理策略。格式导入成功不等于目标运行环境具备全部能力；包内声明也不会自动授予工具与脚本权限。

skills.sh 当前提供目录、搜索与详情 API，但官方文档要求 Vercel OIDC 认证。第一版先支持链接到实际来源的解析与仓库导入；完整目录搜索作为独立、可配置的适配器接入，不预设所有私有部署都能匿名调用。依据：[skills.sh API 文档](https://www.skills.sh/docs/api)。标准格式依据：[Agent Skills Specification](https://agentskills.io/specification)。

验收：至少覆盖来自 2 种来源的真实包、一个多 Skill 仓库、重复导入、上游更新、带脚本或扩展字段的包；来源可追溯，兼容性问题可解释，原有发布不随上游变化。

代码依据：[ZIP 导入入口](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/features/skills/SkillWorkspace.tsx:41)、[标准字段解析](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/skills/archive.ts:26)、[当前版本契约](/Users/ccsert/project/ai-project/mastra-agent/packages/contracts/src/skills.ts:38)。

## 4. 知识库：补齐资料生命周期

对应证据步骤 5—6。当前后端已经具备异步处理、分段、向量存储与召回、可选重排、失败重试和 Agent 发布引用。主要缺口在输入类型、来源追溯和资料维护体验。

- **来源**：先增加文本型 PDF、DOCX，保留 TXT/Markdown；扫描 PDF 的 OCR 能力单独说明，后续再接网页与企业文档同步。
- **处理**：上传后展示解析预览、分段预览与处理阶段；出错说明卡在哪一步，并能重试该阶段。
- **阅读与定位**：分段包含文档标题、页码或段落锚点；检索测试和 Agent 引用都能打开对应原文位置。
- **更新**：同一文档的新版本、变更状态、重新索引、失败恢复；新索引完成前继续使用上次成功版本，切换时明确生效状态。
- **权限**：区分管理资料、直接阅读原文和通过 Agent 使用资料。产品明确每个 Agent 的知识授权范围，并在检索时落实，避免只限制页面入口。
- **检索质量**：保存典型业务问题与期望来源，比较召回/重排结果；先用小型可复现问题集建立验收标准。

验收：PDF/DOCX 导入可追溯到原文；资料更新后能确认索引生效；失败重试不产生重复文档；不具备相应权限的用户不能直接或通过 Agent 检索受限内容。

代码依据：[上传与检索界面](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/features/knowledge/KnowledgeDetails.tsx:180)、[创建配置](/Users/ccsert/project/ai-project/mastra-agent/apps/console/src/features/knowledge/KnowledgeCreate.tsx:108)、[Agent 检索范围](/Users/ccsert/project/ai-project/mastra-agent/apps/control-plane/src/modules/knowledge/knowledge.ts:405)。

## 实施边界

本轮是只读产品审阅与方案整理，未运行新增功能测试；截图只证明可见状态，后端能力判断来自当前代码。本轮未验证完整登录邀请流程、跨用户权限行为、外部 Skill 导入、草稿执行或新文档格式解析，因为这些属于待实现范围。下一阶段按上述验收场景交付并记录真实运行证据。
