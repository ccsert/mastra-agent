# FlowGram → 发布契约 → Mastra 实际往返实验

日期：2026-09-07。对应[研究票 26](../../.scratch/agent-platform/issues/26-flowgram-document-facts.md)。本轮在真实浏览器中接入 FlowGram，复用已完成的[发布契约实验](release-contract-probe-2026-09-07.md)，将线性 Tool/mapping 与固定子流程交给实际 Mastra 执行。没有引入 FlowGram 后端 Runtime。

## 结论

**这条局部集成路径已跑通**：FlowGram 装载、修改、序列化后，受校验的工作流仍可生成同一固定执行摘要，并在 Mastra 中得到同一输出；工具版本改变后生成新摘要并执行新版本。现有结果支持继续采用 FlowGram 编辑、Mastra 执行的主线。

本轮同时把几项容易漏掉的适配责任变成可复现事实：完整替换、执行顺序、字段保存以及历史入口。它们需要集中封装在平台适配层。尚不能据此宣称 FlowGram 的表单、变量系统已降低完整平台的开发量，或给出整个 Agent 平台的工期估算。

## 固定环境与复现入口

| 项目 | 本次实测 |
| --- | --- |
| 编辑框架 | `@flowgram.ai/free-layout-editor 1.0.15`，对应提交 `ba1a9630f80263a196d31993cd85fd1c873d9ddd` |
| UI 与构建 | React/DOM `18.3.1`、Vite `8.2.2`；未装 Ant Design、assistant-ui，不把本实验视为最终前端兼容矩阵 |
| 执行框架 | Mastra `1.64.0`，复用上一实验固定依赖 |
| 运行环境 | macOS、Node `24.13.0`、pnpm `10.32.1`，Playwright CLI 控制真实 Chromium 浏览器 |
| 业务样例 | `orders-report` 调用固定合成订单工具，再调用 `report-helper`，最后映射输出；无真实客户内容或外部模型 |
| 代码与证据 | [独立实验目录](../../.scratch/agent-platform/research/flowgram-roundtrip/README.md)，分支 `research/flowgram-roundtrip`，提交 `ae1864a92e339a3f3aaeed518e517aa04684a497` |
| 复用基线 | release-contract 提交 `175c07c928230b83c929565d182b7f174d0f0b38`；两份主要 JSON 证据记录当前与上游文件摘要 |

npm 与固定源码的对应关系、公开 API 和相关实现链接见[源码核查报告](flowgram-document-source-2026-09-07.md)。运行命令和具体依赖关系在实验 README 中，不要求重新搭建完整平台。

## 已通过的检查

| 证据层 | 结果 | 覆盖及限制 |
| --- | --- | --- |
| [适配器与执行契约](../../.scratch/agent-platform/research/flowgram-roundtrip/evidence/adapter-latest.json) | 21/21 | 往返、按边排序、布局分离、v2 实际执行；断图、分支、环、重复节点、未知字段/端口及缺失 helper 拒绝。这一层不冒称调用了实际 FlowGram |
| [真实编辑器检查](../../.scratch/agent-platform/research/flowgram-roundtrip/evidence/browser-latest.json) | 17/17 | 根/子流程装载、data/端口往返、完整替换、位置历史、字段重载、摘要及真实 Mastra 输出，另含四项明确的框架边界 |
| [实际交互](../../.scratch/agent-platform/research/flowgram-roundtrip/evidence/interaction-latest.json) | 10/10 | 鼠标拖动、Undo/Redo、Meta+Z、主/子流程切换、v2 保存重载、800/375px 布局与页面 JS 错误检查；其中一项是上述 17 项检查的完成标记，覆盖有交集 |
| 安装与构建 | 通过 | 冻结 lockfile 安装与 Vite build。主 JS 约 898KB / gzip 272KB，存在默认 chunk 体积提醒；未做拆包或生产托管验收 |

浏览器的断图反例预期返回 HTTP 422，因此控制台有资源错误记录；交互期间未发生 JavaScript `pageerror`。首轮 favicon 404 已通过本地 data 图标消除。没有把错误全部过滤后声称控制台为零。

[桌面检查截图](../../.scratch/agent-platform/research/flowgram-roundtrip/output/playwright/desktop-checks.png)、[v2 执行结果](../../.scratch/agent-platform/research/flowgram-roundtrip/output/playwright/desktop-v2.png)、[800px](../../.scratch/agent-platform/research/flowgram-roundtrip/output/playwright/width-800.png)、[375px](../../.scratch/agent-platform/research/flowgram-roundtrip/output/playwright/width-375.png)保存了实际画布。窄屏检查只确认此实验页面无横向溢出、面板不覆盖画布，并提供适应画布入口，不等于移动端完整编辑体验验收。

## 往返契约

编辑时，工作流 schema 和标识放在平台封装 `spec`；节点类型与业务字段放 FlowGram `node.data`，执行边放 `edges`，坐标放 `meta.position`。没有另存一份可能与画布失配的可执行 graph。导出时先严格检查允许字段，再按边恢复线性步骤，最后交由上一实验的发布编译器处理。

| 改动 | 实际观察 |
| --- | --- |
| 根流程与子流程分别装载、保存 | 固定执行摘要保持 `5b203287…`，输出 `east: 120` / `total: 120` |
| 拖动节点或通过公开 BaseService 改坐标 | 布局摘要改变，执行摘要不变，结果不变 |
| 工具 `query-orders-v1` 改为 `query-orders-v2` | 执行摘要变为 `2c8183d8…`，输出 `east: 240` / `total: 240`，保存并跨流程切换后仍保留 |
| 导出的 nodes 数组换序 | 按边重建后摘要不变；重复整稿装载实际出现顺序变化，检验按节点 ID 比较 data |
| 删除一条必需连线 | 适配器拒绝 `DISCONNECTED_OR_CYCLIC_GRAPH`，不会删除或猜补连线后继续执行 |

上述摘要只是本实验特定代码/依赖的观测值，完整值在 JSON 证据中；不能用作未来平台的固定常量。

## 四项必须显式处理的框架边界

1. **整份草稿替换不能只用 `document.fromJSON`。** 传入只含一个节点的 JSON 后，旧节点仍存在；`operation.fromJSON` 才删除缺席节点和旧线。切换草稿应按完整替换处理，并明确历史归属。
2. **默认序列化不透明保存所有字段。** 本次人为添加的文档顶层和 metadata 字段被默认序列化丢弃。导入前必须检查扩展字段；需要额外信息时明确使用平台封装或已验收的扩展钩子。
3. **纯 data 字段修改没有默认 Undo。** `updateExtInfo` 可以保存并重载工具 v2，但不会自动产生字段历史。完整 AI 修改、撤销和修订冲突仍需平台修订机制，或接入表单引擎后独立验证。
4. **1.0.15 的默认位移服务与历史监听存在实例差异。** 本次浏览器确认 `ctx.operation !== ctx.get(WorkflowOperationBaseService)`；前者改坐标但没有对应 Undo，后者可记录并正确 Undo/Redo。原生鼠标拖动及键盘撤销另有实际证据。500ms 只是合并窗口，延长等待不能解决实例差异。实验使用公开 BaseService 入口，没有修改依赖包源码。

第四项是在浏览器反例后修正的源码推断；没有把它扩大成 FlowGram 全部历史不可用。来源细节及公开入口见[固定源码核查](flowgram-document-source-2026-09-07.md)。后续升级框架版本需要重跑这些行为，不能只保证 TypeScript 编译通过。

## 下一阶段与当前边界

下一项最有价值的调查是 **FlowGram 表单引擎与变量引用如何对应平台严格 schema、字段历史和 AI 草稿修订**。它直接决定能复用多少配置编辑能力，应在现有固定版本上做局部验证，再将已验证约束写入完整编排规格。

本轮未接入真实 AI、Agent 节点、parallel/conditional/foreach、持久草稿库、多人 baseRevision 冲突、正式发布激活或 Runtime 故障恢复；图模型与发布政策仍按原决策票收敛。[完整原型票 10](../../.scratch/agent-platform/issues/10-flowgram-mastra-prototype.md)保持 open，未回答的产品问题保持原状。研究票 26 的事实范围已完成，不把 17 项检查替代完整首期验收。
