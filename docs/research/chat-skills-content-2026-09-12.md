# Chat 的 Skill 选择与内容展示优化

## 参照与问题

本轮实际查看本机 DSH（127.0.0.1:3080）的斜杠选择面板，并阅读本地 DSH `ui-skill/SkillRow.tsx`。参考其名称与用途并列、紧凑过程行、专门的 Skill 指令阅读区；没有复制其业务代码或引入第二套聊天 runtime。

原实现的问题：

- “快捷指令”按钮向正文追加 `/`；能力选择与消息编写混在一起，已选能力缺少明确的后续反馈。
- 实时用户消息没有携带选择信息；刷新后的服务端历史却有，实时与历史展示不同。
- Skill 指令和规则文件使用普通工具原文展示，脚本的结构化结果、stdout 和完整记录重复堆叠。
- 预选 Skill 只注入原始 SKILL.md，没有使用 Mastra 激活格式所提供的包内文件目录。
- 快速切回会话可能命中 30 秒能力缓存；用户消息底部自定义标签没有进入正确的 grid 列，挤成 72px 宽的两行。

## 已落地

### 输入与选择

Ant Design Popover/Input 提供独立 Skills 面板：按名称和用途检索、固定版本、多选、十项上限、停用提示、移除和加载失败重试。打开面板不改写消息草稿。搜索框在面板显示后聚焦；Escape 的处理避开中文输入法组字。

保留 assistant-ui 原生 TriggerPopover、键盘选择、历史和 IME 行为。支持行内 `/name`，兼容 `/skill name`；URL、普通文件路径和反引号代码块不被当作指令。选中后只移除触发文本。

通过 `useChatRuntime` 的 `isSendDisabled` 与 `toCreateMessage` 接入可用性检查和即时选择元数据。切回会话重新确认版本可用性；服务端接受请求前保留所选 IDs。用户消息显示“本次指定”，实际使用仍由工具调用记录证明。版本名称不充当后端授权依据。

### 内容阅读

- `skill`：Skill 指南的 Markdown 阅读、原文、精确复制和内容规模。
- `skill_read`：明确 Skill、包内路径与真实行范围；Markdown 文档提供阅读/原文，其他文件保留原文。相对文件引用不错误跳转到 Console 页面。
- `run_skill_script`：默认显示可解析的结构化结果；“输出”展示 stdout/stderr；“完整记录”保留版本、digest 等原始数据。非零退出码优先显示输出。
- 复用现有 Markdown、ToolResult、复制 hook 和 Ant Design Tabs。保留参数、错误、单工具轨迹入口，以及计划、子代理和知识来源的既有渲染。
- 用户指定标签与气泡右侧对齐，常规正文表格与简单脚本表格采用自然宽度；长代码与文档局部滚动。28px 过程行和 32px 操作栏占位保留。

### Runtime

显式选择 Skill 使用 `workspace.skills.get` 与 Mastra 的 `formatSkillActivation`，与原生 `skill` 工具共用激活格式，提供规范指令及 References/Scripts/Assets 目录。版本快照、内容 hash 校验、停用检查和脚本入口授权继续生效；选择本身不会执行脚本或增加权限。目录可读不代表脚本已授权。

## 验证

- Console 全量 110/110 通过；最后的面板焦点、Escape/IME 调整后，六项 Skill 交互回归再次通过。
- 后端 87 项通过，两个需要专用 `SKILL_TEST_IMAGE` 的沙箱测试按环境跳过。新增 Runtime 单测验证固定版本、目录、未选择的惰性注入以及停用/篡改拒绝；既有完整 Skill 集成测试增加第一条模型请求中的目录断言。
- TypeScript、Biome、依赖架构检查、Console 构建通过；改动的 Ant Design 组件 lint 无问题。构建仍提示既有大 chunk。
- 浏览器检查旧 Skill 历史的规则阅读、脚本结果/原文，以及新会话刷新还原。正常 1562px 视口下，简单脚本表格 440px，用户选择标签 20px 高且位于消息第二列。390px 下选择面板不再使文档横向溢出。浏览器自动化用“完成选择”完成关闭验收；Escape/IME 关闭和焦点恢复由组件回归覆盖。

### 新的真实执行

确认零个活动 Run 后重启本地 Runtime，`/ready` 返回 ready。

- 会话：`59d0d666-c94b-4e31-b7c6-6e8bf4bd99ef`
- Run：`6b3435e3-e6a3-40ba-9ad1-a55fce3f8b32`，succeeded
- 指定并持久化：`order-summary v1`，版本 `33da7bed-faea-40c2-b2ba-8c1b6f29d820`
- 813 个事件、3 次模型请求；第一条请求确实包含显式选择指令与 References/Scripts 目录。
- 实际调用：`skill` → `skill_read` → `run_skill_script`
- 合成输入：SKILL-UI-001 = 12.35、SKILL-UI-002 = 7.65；脚本退出码 0，stdout 中 count=2、total=20。

本轮为本地实现与验收，没有提交、推送或发布。没有接通附件上传、人工审批、编辑分支等尚缺后端协议的能力，也没有把选中标签当作这些能力的已实现证明。

验证输出：`.scratch/chat-skills-20260912/`。上游接入说明同步在 `shared/assistant-ui/UPSTREAM.md`。
