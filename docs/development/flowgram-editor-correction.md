# FlowGram 编辑器集成纠偏

2026-09-08。基线 `e7961d7501c8789c957a14faca3e2ef0bedfc2f1`。用户指出正式平台未充分应用 FlowGram 能力，本次先修正编排编辑器，不继续扩展其他平台模块。

## 问题与范围

原实现使用真实 FreeLayoutEditorProvider，但完整节点参数由独立 React state 保存，变量候选靠手写前驱遍历，撤销重做靠外层整图快照。仅名称进入 Field；自动布局也由平台自行计算。M4 已验证执行闭环，不能据此宣称实现了 FlowGram 完整编排能力。

本次保持平台 Workflow Definition、固定发布、AI 候选审阅、OpenAPI/生成 SDK 和 Mastra 执行不变。限定为当前六类节点的编辑基础能力，不在本次开放并行、循环、汇合或引入 FlowGram Runtime。

## 接入要求

- 节点业务数据只有 FlowGram Form 一份可编辑状态。Ant Design 是字段外观；名称及参数通过 Field 绑定，资源变更等联动通过节点表单 API 写入。抽屉复用现有 FormControl。字符串尚无法解析成 JSON 时允许保留输入文字，修正后才能关闭配置。
- 删除 React past/future 历史栈。节点字段、删除、连线、拖动由 FlowGram History 接管；整图修改和流程元数据使用同一 History 事务，一次撤销恢复整个修改。保存不重新导入文档、不增加历史条目。
- 使用 FlowGram Variable Engine 自由布局作用域。平台把 JSON Schema 投影为 AST，变量面板只读取当前节点的 available 变量。映射节点的引用使用 KeyPathExpression；常量对象声明其字段。前端不宣称替代服务端完整 Schema 兼容性校验。
- 删除上游或字段后，在 FlowGram 校验及节点错误标记中显示引用问题；撤销后恢复。变量选择列表限制显示规模，引用校验直接查询作用域，不能用被截断的候选列表作校验依据。
- 自动布局调用 tools.autoLayout；缩放、fitView、官方 minimap 和 free-snap 插件进入正式页面。新增节点保留已有节点位置，整体重排由用户明确点击。
- canAddLine 提前阻止自环、重复出口、汇合及循环；服务端发布仍独立拒绝无效图。开始节点不能删除。

## 固定版本注意事项

全部 FlowGram 包固定 1.0.15。该版本 WorkflowOperationService 与位置历史监听使用的 BaseService 是不同实例，整图事务通过公开 WorkflowOperationBaseService 装载，并显式 startTransaction/finally/endTransaction。

FreeHistoryPluginOptions 声明了 operationMetas，但该版本实现没有消费这个字段。流程名称、说明和输入输出 Schema 的元数据操作通过 history.operationRegistry.registerOperationMeta 注册，仍使用同一个原生历史栈。浏览器曾检出依靠配置字段会导致元数据修改异常，现通过公开注册入口修正。

依据：[官方表单文档](https://flowgram.ai/guide/form/form)、[官方编辑器示例](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/hooks/use-editor-props.tsx)、本地锁定版本声明及发布包源码；历史服务实例差异亦见已有 [源码核查](../research/flowgram-document-source-2026-09-07.md)。

## 验收与剩余

已用正式 5179 生产构建页面检查名称和参数修改的原生撤销重做、删除上游后的失效引用及撤销恢复、自动布局撤销、名称和 Schema 的单事务撤销重做、条件插入带来的多节点和连线修改的单事务撤销重做。整份导出定义及布局与之前保存的六节点草稿比较一致。检查通过拦截并中止保存请求读取导出内容，没有覆盖用户保存的业务草稿或发布版本。

自动化连线边界测试覆盖合法条件路径、自环、错误端口、重复出口、汇合和循环。全仓 20 组测试、类型检查、构建、Biome 和 AntD 扫描通过。构建仍提示大分块：工作流约 815 KB（压缩前），性能预算尚未验收。

真实鼠标连线验证了合法连线与原生撤销重做，以及重复出口被拒绝；已连接端口当前需要先删除旧线再重连，不宣称支持拖动旧线直接换端点。两条分支的变量候选来自各自的上游作用域；删除上游后的引用错误会同时出现在节点与字段上。

Standards 和 Spec 两条独立审查检出并关闭了：隐藏比较值留下错误状态导致抽屉无法关闭，以及名称首尾空格在服务端规范化后导致错误的“未保存”判断。浏览器复验覆盖无效 JSON 不被普通重渲染清除、切换 exists 后可关闭、撤销只恢复合法 JSON、导出名称规范化及保存后正常离开。保存响应使用本地 HTTP 拦截 fixture，专门检验编辑器状态，不冒充新的后台持久化验收。

浏览器脚本在忽略目录 `.local/flowgram-editor/`，1440 / 1024 / 768 / 390 宽度截图在 `output/playwright/flowgram-editor/`。页面无横向溢出，配置抽屉在屏幕范围内。缩略图使用官方 MinimapRender，固定在画布容器内，避免官方默认窗口定位覆盖其他面板。没有将账号、Cookie 或模型密钥加入提交。

后续已在 [编排工作台整改](flowgram-workbench.md) 中接入节点物料面板、连线中插入、停靠面板和完整工具栏，并补充相应验收。仍待交付：画布上的实时执行状态与节点详情、可视化复杂 Schema 编辑、并行/循环/子流程及其 Mastra 适配、复杂类型推断与大图性能验收。未接入的官方物料和 Runtime 插件不能视为已交付的平台能力。
