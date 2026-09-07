# Agent Skills 格式与上传校验边界

核查日期：2026-09-07。仅查阅 Agent Skills 官方规范与 `agentskills/agentskills` 官方仓库；未安装、未运行校验器，以下源码行为属于静态核查。仓库 `main` 查询到的提交为 `69ef37e9424c0a7ea9dd2293b559e43ec8176379`，实现引用固定于该提交。当前工作目录无 Git 仓库，本研究未创建仓库或研究分支。

## 结论

用户已明确采用标准 Agent Skills 格式并支持压缩包上传。标准约束的是解包后的 Skill 目录与内容；归档容器和上传规则需由平台补充。官方提供 `skills-ref` 作为参考，但 README 明确将它定位为演示用途、不面向生产；可以评估复用其规则、实现与测试，不能直接视为完整的企业上传验收方案。[格式规范](https://agentskills.io/specification)、[参考库说明](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/README.md)

## 格式要求与建议

一个 Skill 是一个目录，根目录包含 `SKILL.md`，文件先写 YAML frontmatter，再写 Markdown 指令。`scripts/`、`references/`、`assets/` 均为可选组织惯例，也允许其他文件和目录。[目录与文件格式](https://agentskills.io/specification#directory-structure)

| 字段 | 标准要求 |
| --- | --- |
| `name` | 必需，1–64 字符；Unicode 字母数字与连字符，须符合小写约束；禁止首尾连字符及连续连字符；须与所属目录名一致 |
| `description` | 必需，非空，1–1024 字符 |
| `license` | 可选，许可证名称或随包许可证文件引用 |
| `compatibility` | 可选，提供时 1–500 字符，描述环境要求 |
| `metadata` | 可选，字符串键到字符串值的映射 |
| `allowed-tools` | 可选，以空格分隔的工具声明；**实验性字段**，客户端支持可能不同 |

以上来自[官方字段规范](https://agentskills.io/specification#frontmatter)。说明使用场景、拆分长文档、正文少于约 5000 tokens／500 行及保持引用浅层，属于编写与渐进加载建议，不能全部变成“超过即违反格式”的统一硬门槛。[正文和渐进加载](https://agentskills.io/specification#body-content)

名称不能简单实现为 ASCII 正则 `[a-z0-9-]+` 后宣称完整兼容。官方参考实现使用 Unicode 字符检查和 NFKC 归一化，仓库测试明确包含中文、俄文和组合字符名称；若平台另限 ASCII，应公开标识为平台限制。[名称实现](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)、[名称测试](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/tests/test_validator.py)

## 官方校验器覆盖到哪里

参考命令是 `skills-ref validate path/to/skill`，也提供 Python `validate(Path(...))` API。它检查目录和 Skill 文件、frontmatter 可解析性、已知顶层字段、必需字段、名称及目录匹配、描述长度和部分 compatibility 约束。[CLI 与 API](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/README.md)、[校验实现](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)

静态阅读还发现这些必须单独处理的边界：

- 校验器拒绝六个已知字段之外的顶层 frontmatter；平台扩展可放在标准 `metadata` 中，但平台的实际授权记录不能由上传文件自行授予。
- 源码未完整约束 `metadata` 的字符串映射类型、`license` 和 `allowed-tools` 的类型与语义；`compatibility` 实现检查类型和上限，没有落实规范的非空下限。
- 解析器还接受小写 `skill.md`；这属于参考实现的兼容行为，规范的文件名写作 `SKILL.md`。`read-properties` 只读取属性，不能替代完整校验。
- 未见归档解包、递归资源完整性、脚本正确性、签名、恶意内容或执行隔离检查；正文也没有被该校验入口用于语义验收。

这些结论只针对所核查版本的[校验器](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)与[解析器](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/parser.py)。参考库为 Apache-2.0；复用路径可行性仍需实现评估与真实用例验证。[参考库许可与定位](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/README.md)

## 压缩包与平台政策

在本次限定的格式规范中，未规定 ZIP／tar、归档后缀、包内外层包装、单包一个还是多个 Skill、签名或平台租户授权协议；这些是平台接入契约。这个判断来自规范覆盖范围与校验入口，不表示其他产品没有各自约定。[格式规范](https://agentskills.io/specification)、[目录校验入口](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py)

建议后续平台决策区分三项验收，以下均为工程建议，尚未由用户确认具体策略：

1. **上传容器**：定义支持的归档类型、Skill 根目录识别、包数量、解包体积／文件数、路径及符号链接规则。归档是否有一层包装不应与 Skill 名称匹配规则混淆。
2. **格式符合性**：以固定版本的标准规则检查解包后的目录，区分强制错误、建议提示和平台限制；用官方参考测试辅助建立兼容用例。
3. **发布与运行许可**：平台决定谁可导入、发布、绑定和执行，以及脚本、网络、凭据、工具可用范围。包内声明是待审输入，不能取代平台授权。

**标准允许携带脚本，不等于本平台已决定允许执行脚本；格式校验成功也不证明代码安全。** `allowed-tools` 的实验性声明不能自动获得平台工具权限。脚本实际语言支持由 Agent 实现决定，运行隔离、依赖供应和授权仍是后续平台决策。[脚本约定](https://agentskills.io/specification#scripts)、[实验性工具字段](https://agentskills.io/specification#allowed-tools-field)

## 后续验证

实施前固定规范与参考库版本，补齐元数据类型、Unicode／目录匹配、文件名兼容、归档层级及失败诊断样例；独立验证脚本执行政策。本轮仅形成研究结论，没有上传验收、运行安全或兼容性测试通过的证据。
