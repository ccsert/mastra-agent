# Skills 多来源导入交付记录

日期：2026-09-13。范围承接平台管理方案第 3 阶段。本轮实现 Skills 来源导入与版本更新，知识库资料生命周期仍是下一阶段。

## 用户可用的流程

进入项目的「Skills → 导入 Skill」，粘贴来源链接或选择 ZIP，先检查内容，再确认导入固定版本。

| 来源 | 可用输入 | 行为 |
| --- | --- | --- |
| skills.sh | 具体 Skill 详情链接；`owner/repo@skill` | 定位 GitHub 仓库，通过实际 Skill 名称或目录名匹配候选 |
| GitHub | `owner/repo`、HTTPS 仓库、tree/blob 子目录链接 | 列出多个 Skill，支持分支、标签、完整提交号与子目录 |
| GitLab.com | 公开仓库、子组仓库与 `/-/tree/` 链接 | 按提交读取目录与文件，处理树分页 |
| ZIP | 单个标准包，压缩体积不超过 4 MiB | 与远端来源共用预览、校验、版本差异和确认逻辑 |

界面包含：来源与固定提交、候选 Skill 所在目录、文件树、指令原文、许可证声明、脚本入口、兼容性说明、新增/修改/删除文件，以及选中文件的新旧内容对照。来源详情和提交链接可回溯上游。

远端版本详情增加「检查上游更新」。确认更新只创建新的 Skill 版本；已经发布的 Agent 仍引用原来的固定版本。相同内容复用已有版本，保留原来源记录和启停状态。

解析和预览期间可以取消，失败后保留已选择的 ZIP 供重试。提交导入期间暂时禁用关闭；请求失败时仍保留预览供检查。

## 后端实现和不变量

- 增加数据库 migration 17：Skill 版本 `source` 与 `skill_import_previews`。
- 预览将已校验的 ZIP 内容保存在数据库，绑定租户、项目和操作者；确认仅使用这些内容，不重新访问上游。
- 预览有效期 1 小时；每个项目的每位操作者保留最近 10 个预览。创建新预览时清理该项目的过期预览；确认成功释放暂存 ZIP。没有定时清理进程，因此长期不再使用的项目可保留过期记录至下次导入。
- 确认在事务中检查当前权限、内容摘要和项目内最新版本；并发重复确认返回同一版本，预览后他人导入不同内容会返回冲突。
- 预览只读取最新版本及相同摘要版本进行比较，不加载所有历史版本。
- 远端导入只构造 GitHub、GitLab.com 官方 HTTPS 端点；不读取主机 Git 凭据，不运行 Git、安装命令、钩子或包内脚本，不跟随 HTTP 重定向。
- 源码内容由 Git blob SHA-1 校验，生成平台包后再执行原有 ZIP 校验和 SHA-256 内容摘要校验。二进制内容按原始字节保存。
- 单个 Skill 最多 200 个文件、单文件 2 MiB、展开总量 16 MiB、最终 ZIP 4 MiB。拒绝链接、特殊文件、越界/冲突路径、Git LFS 指针、被截断的仓库树和不完整读取。
- GitHub 树上限 20,000 项，GitLab 上限 50 页/5,000 项，最多列出 100 个 Skill；每批最多读取 4 个文件，单进程最多 4 个远端操作，每次 90 秒超时。达到限制时明确报错，不把部分内容当成完整 Skill。
- 扩展 frontmatter 字段保留在 SKILL.md 原文字节中，并单独列出“不生效”的字段名。平台不应用包内模型、工具、网络、钩子或代理执行配置。
- 远端与 ZIP 预览、确认需要 `resource.edit`；启停仍需要 `resource.manage`；导入不产生 Agent 脚本执行授权。
- 导入审计记录操作者、版本、来源、提交、摘要和是否复用；不写入文件正文。

公开端点与生成 SDK：

- `POST /projects/{projectId}/skills/discover`
- `POST /projects/{projectId}/skills/previews`
- `GET /projects/{projectId}/skills/previews/{id}/file`
- `POST /projects/{projectId}/skills/previews/{id}/confirm`
- `POST /projects/{projectId}/skills/{id}/update-preview`

原 ZIP 上传 API 保留兼容；控制台已统一走预览后确认流程。新增确认与更新请求显式声明 JSON body，符合既有控制面请求约束。

## 验证记录

- 全套后端：123 tests，119 passed，4 skipped，0 failed。日志 `.scratch/skill-sources-all-backend.log`。跳过项依赖额外运行环境，不能算作本轮实际执行通过。
- 最终后端定向回归：8 passed。包括随后补充的 skills.sh 路径与声明对应检查、LFS/缺失文件检查，以及最后的查询范围和权限复查调整。日志 `.scratch/skill-sources-final-focused.log`。
- 前端定向：6 passed。覆盖来源变更清除旧候选、固定 commit/path 提交、原文检查、兼容性、过期/冲突提示、已删除文件对照、取消与失败重试。日志 `.scratch/skill-sources-final-console-focused.log`。
- 前端全套最终结果：144 passed，0 failed。日志 `.scratch/skill-sources-console-final.log`。
- 构建、TypeScript、Biome、模块依赖检查、OpenAPI/SDK 一致性与 Ant Design lint 均通过；最终窄屏宽度修正后，控制台构建、TypeScript 和 Ant Design lint 再次通过（`.scratch/skill-sources-width-*.log`）。
- Vite 仍有既有大 chunk 提示；JSDOM 对部分 CSS 有解析告警。实际布局另用浏览器验收，本轮未处理无关聊天 bundle 或 CSS 测试环境问题。

集成测试使用隔离数据库 schema 和合成成员，验证个人预览隔离、租户/项目范围、编辑者不能授权新脚本、撤权后拒绝访问、相同内容去重、版本冲突、预览过期、禁用版本不被自动启用、发布快照不受更新影响。GitLab 的分页与内容适配由模拟官方 API 的测试验证，未将其表述为真实 GitLab 线上导入验收。

## 真实来源与浏览器

本地项目：企业知识助手，`72557c75-2f3d-42ce-9f88-2b76aebc959f`。

| 样本 | 固定提交 | 内容摘要 |
| --- | --- | --- |
| Vercel web-design-guidelines / skills.sh | `063bee94c3f4df8453406c830b0a7df0f2860278` | `2543fee0965402541ed1bbacac958f0e7773db7d96c730662e7485dd86c145e1` |
| Anthropic frontend-design / GitHub | `34040c9c568585f6929bedeaad110ad08f079624` | `ed1ae51a8f1f29f50d3ed4568965df18d9a38e8389577d3dc836275d163fc309` |

已通过真实网络读取两个样本及其文件完整性检查。浏览器已完成 skills.sh 样本导入与重复确认，Skill 版本 ID `02dc92f5-f841-4541-b35b-8de6b9d466b6`；重复检查后仍为同一 v1。Anthropic 完整仓库扫描得到 20 个 Skill，验证了候选列表分页与指定目录预览；已在窄屏完成 frontend-design v1 导入，版本 ID `257bb7cf-870a-4cfb-91c2-6b2f23ec4bd3`。刷新后仍显示同一 v1、来源提交和内容摘要。

截图目录：`.scratch/skill-sources-20260913/`。01 为 skills.sh 预览、02 为无上游变更、03 为多 Skill 仓库、04 为 GitHub 预览；05 为窄屏预览，06 为窄屏内容滚动，07 为导入后刷新恢复。

窄屏验收曾发现固定尺寸抽屉左侧被裁切，现已改用 `min(1080px, 100vw)` / `min(1120px, 100vw)`。390×844 实测：dialog x=0、width=390，documentWidth=390；文件树与内容改为纵向排列，底部取消/返回/确认操作可用。验收后已恢复浏览器原尺寸。

## 本轮边界

这是本地工作区实现，尚未提交、推送或部署生产。数据库迁移已用于本地运行与隔离测试，未进行生产迁移演练。

当前支持公开来源链接，未实现 skills.sh 目录搜索、私有仓库凭据、自建 Git 服务接入、批量自动更新或跨平台运行环境安装。支持从多 Skill 仓库逐个选择并导入；没有一次确认批量导入多个 Skill 的入口。

兼容性页展示包内声明和平台规则，不等于依赖安装或脚本试跑通过。没有为示例 Skill 绑定 Agent、授予脚本权限或改变正式发布。

## 参考依据

skills.sh 的仓库映射和输入格式参考其[官方文档](https://www.skills.sh/docs)及[官方 CLI 仓库](https://github.com/vercel-labs/skills)；具体样本页面提供 GitHub 来源与 Skill 名称。[web-design-guidelines 来源](https://www.skills.sh/vercel-labs/agent-skills/web-design-guidelines)

标准元数据与资源结构依据 [Agent Skills Specification](https://agentskills.io/specification)。仓库树、文件 mode、截断与分页规则分别依据 [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees) 和 [GitLab Repositories API](https://docs.gitlab.com/api/repositories/)。ZIP 生成使用已有依赖生态中的 JSZip，读取仍由原有有界 yauzl 解析器负责。[JSZip 生成文档](https://stuk.github.io/jszip/documentation/api_jszip/generate_async.html)

![导入前检查固定来源与内容](/Users/ccsert/project/ai-project/mastra-agent/.scratch/skill-sources-20260913/01-source-preview.png)
