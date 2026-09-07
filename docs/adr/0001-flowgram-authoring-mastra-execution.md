---
status: accepted
date: 2026-09-07
---

# FlowGram 负责流程编排与编辑，Mastra 负责执行

用户已确认采用 FlowGram 作为流程编排与编辑核心，并以 Mastra 为主要执行基础。平台需要完整的节点配置、变量引用和 AI 修改能力，采用 FlowGram 可复用相关编辑机制，减少基于裸 React Flow 自行建设的范围；实际执行、运行状态和恢复语义统一由 Mastra 所在的 Runtime 承担。

平台负责定义校验、版本发布和编辑模型到 Mastra 的语义映射。这个决策不引入 FlowGram 后端执行引擎；发布流程应限制为 Mastra 可表达的控制结构。定义往返转换、AI 修改撤销、动态参数表单和故障恢复仍需原型验证。

比较背景：[FlowGram 与 React Flow](../planning/flowgram-vs-react-flow.md)。

2026-09-07 验证进展：[FlowGram 局部往返实验](../research/flowgram-roundtrip-probe-2026-09-07.md)已验证真实编辑器与固定 Tool/mapping/helper 的 Mastra 执行一致性，并明确导入、排序、序列化与历史入口的适配边界；完整表单变量、真实 AI 和恢复验收尚未完成。该进展不改变上述架构决策。
