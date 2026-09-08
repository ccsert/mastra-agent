# 工作流节点配置表单

2026-09-08，基线 `b268711`。用户指出条件判断不明所以、Agent 提示词输入体验差，并明确仅考虑桌面端。本轮按六类可执行节点的用途调整右侧表单，保持 FlowGram 编排、Mastra 执行和既有发布契约。

## 实现

- 侧栏默认宽 480 px，可在 400–720 px 间调整；节点类型、用途、资源、输入与输出分区显示。
- 条件节点显示 IF 判断规则、可读变量名、实时规则摘要及真实 true/false 连线的目标节点。数值大小判断只供数值使用；等值比较两侧类型一致；“有值”意味着非 undefined/null，空字符串、0、false 仍有值。
- Agent 使用官方 `@flowgram.ai/coze-editor@1.0.15` 的 prompt preset，支持多行 Markdown、平台 `${path}` 变量高亮、光标/选区插入、已引用变量、字符计数及 920 px 展开编辑。提示词按需加载，未整体引入带 Semi 的 form-materials。
- “编写任务”“引用变量”“纯文本”分别保留 template/ref/literal 的执行语义。纯文本不替换变量；Agent 的角色和工具授权来自所选已发布版本，表单不重复配置模型或密钥。
- 开始节点显示输入契约；工具显示输入类型、必填、说明及输出结构；映射支持命名字段且禁止重复覆盖；结束节点明确返回结果。数值、布尔、枚举、对象、数组使用对应输入形式，可选字段显式启用或移除。
- 数据仍由 FlowGram Form/History 管理。JSON 和未完成数值仅留在本地输入草稿，无效时阻止离开节点及保存；有效值和提示词进入原有历史。外部撤销/重做同步编辑器，防止内容回写形成新的历史。
- 变量树仍由 FlowGram Variable Engine 提供作用域；显示业务名称，同时保留路径作为辅助信息。禁止选择类型不适配或未经存在性检查的可空变量。

## 主源

对照固定 1.0.15 源码：
- [官方 FormInputs：按 schema 选择动态值或提示词编辑器](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/form-components/form-inputs/index.tsx)
- [官方 PromptEditor：EditorProvider + Renderer + prompt preset](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-materials/src/components/prompt-editor/editor.tsx)

平台沿用 `${path}`，未把官方示例的其他表达式语法或未获 Runtime 支持的运算符带入执行契约。本轮没有增加 AND/OR、多条件组、循环或分支汇合。

## 验收记录

工程与桌面浏览器回归进行中，最终记录在完成后补齐。现有订单采购报告的草稿修订 7 / 发布 v2 不作为本轮写入目标。
