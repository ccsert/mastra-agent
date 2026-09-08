# FlowGram 完整编辑器最佳实践与平台适配

核查日期：2026-09-08。核查基线：平台 `f2ddca1`，FlowGram npm `1.0.15`；官方源码固定到该发布的 `gitHead`：`ba1a9630f80263a196d31993cd85fd1c873d9ddd`。本文区分官方事实、当前差距和实施建议，不把源码阅读视为浏览器或运行验收。

## 结论

平台应以官方 **demo-free-layout 的完整编辑器组织和交互**为参考重做工作区。只开启 Form、Variable、History 并不能获得官方示例的使用体验。官方将画布、面板、节点表单、局部插入、快捷操作及运行反馈组合为编辑器；其源码可供分层复用。[官方最佳实践入口](https://flowgram.ai/examples/free-layout/free-feature-overview)、[完整 Demo 源码](https://github.com/bytedance/flowgram.ai/tree/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout)

采用 React/Vite/AntD 6 不妨碍这种组织。官方明确允许通过物料源码定制更换底层 UI；不要求平台改用 Demo 的 Rsbuild/Semi。编辑交互应由 FlowGram 原生文档、端口、选择、表单与历史机制承载，平台继续负责资源目录、授权、草稿/发布和 Mastra 执行。[官方物料定制指南](https://flowgram.ai/materials/introduction)、[既定执行边界](../adr/0001-flowgram-authoring-mastra-execution.md)

## 当前差距与首轮取舍

下表“当前”指本次读取的 `f2ddca1`，不是对随后代码改动的验收。

| 场景 | 当前基线 | 官方机制与建议 |
| --- | --- | --- |
| 进入编排 | 管理页面内固定 560px 画布，常驻 310px AI 面板 | 给编辑器主要可视空间；AI、节点配置、调试通过面板切换，保留可读缩放，不因开关侧栏反复全图 fit。 |
| 配置节点 | 点击后打开遮罩 Drawer | 使用无模态侧面板；节点选择与面板内容联动，允许继续点击/拖动画布。 |
| 理解节点 | 卡片主要展示类型、标题、ID | 画布展示输入/输出与业务摘要；侧栏展示同一 Form 的详细配置。 |
| 添加节点 | 顶部一排类型按钮，并按外部选择状态插入 | 统一节点面板，连接端口、拖线空白处、连线中间和空白画布都能就地调用。 |
| 修改引用 | 平铺变量 Select | 按上游节点与对象属性分组的变量树，显示类型、引用来源和无效引用。 |
| 高频编辑 | 有 undo/redo，但缺节点菜单及完整选择/复制操作 | 快捷键注册、选择服务和节点菜单统一调用相同操作；事务式撤销。 |
| 调试 | 编辑与运行查看分离 | 同一工作区提供真实运行输入、结果、节点状态与错误定位。 |

当前证据：[Canvas](../../apps/console/src/WorkflowCanvas.tsx)、[工作流页面](../../apps/console/src/Workflows.tsx)、[字段编辑](../../apps/console/src/WorkflowFields.tsx)、[样式](../../apps/console/src/workflows.css)。右列是基于以下官方源码的实施建议，不能用布局变化代替功能验收。

## 1. 工作区与面板

官方 `editor.tsx` 在 Provider 内使用 `DockedPanelLayer` 包裹 `EditorRenderer`；编辑器占满自身容器。面板工厂分别注册节点配置、试运行和问题列表。示例节点面板默认宽 500、范围 300–800，运行面板默认宽 400；这些是示例参数，应按平台窗口调整。[Editor](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/editor.tsx)、[面板工厂](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/plugins/panel-manager-plugin/index.tsx)、[样式](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/styles/index.css)

公开接口：

```tsx
import {
  createPanelManagerPlugin, DockedPanelLayer, PanelManager,
  type PanelFactory,
} from '@flowgram.ai/panel-manager-plugin';

// Provider.plugins 中注册一次：
createPanelManagerPlugin({ factories: [nodeFactory, aiFactory, runFactory] });

// Provider 内：
<DockedPanelLayer><EditorRenderer /></DockedPanelLayer>;

// nodeFactory.render 根据 nodeId 读取原生 node/form：
ctx.get(PanelManager).open('node', 'docked-right', { props: { nodeId } });
ctx.get(PanelManager).close('node');
```

示意中工厂由平台定义。官方实际将节点表单放在 `right`，试运行放在 `docked-right`，问题列表放在 `bottom`；`docked-right` 是挤出画布空间的选择，不能把所有位置都理解成同样的抽屉。文档还给出 `getPopupContainer`、`autoResize` 等配置。[官方面板 hooks](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/plugins/panel-manager-plugin/hooks.ts)、[PanelManager 文档](https://flowgram.ai/guide/plugin/panel-manager-plugin)

节点侧栏通过 `PlaygroundEntityContext` 指向当前 node，`useNodeRender(node).form.render()` 渲染原生表单；监听 selection、readonly 与 node dispose。平台已有共用 Form control 的实现可以保留，只替换呈现容器和面板生命周期，避免重新维护第二份节点数据。[NodeFormPanel](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/sidebar/node-form-panel.tsx)、[SidebarNodeRenderer](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/sidebar/sidebar-node-renderer.tsx)

建议关闭面板只影响界面；不要原样复制示例“关闭运行面板自动取消任务”的行为，平台的已发布版本执行应遵循现有任务取消契约。

## 2. 节点面板、端口与连线插入

新增 `@flowgram.ai/free-node-panel-plugin@1.0.15`，用 `createFreeNodePanelPlugin({renderer: PlatformNodePanel})` 注册一次。官方渲染器接收 `position`、`onSelect`、`onClose`、`containerNode`、`panelProps`。物料列表从节点 registry 读取类型、图标、说明、`onAdd` 和 `canAdd`，而不是散落的按钮定义。[NodePanel](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/node-panel/index.tsx)、[NodeList](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/node-panel/node-list.tsx)

`WorkflowNodePanelService` 提供两层接口：

| 接口 | 行为 | 平台用法 |
| --- | --- | --- |
| `singleSelectNodePanel({position,containerNode,panelProps})` | 返回 `{nodeType,nodeJSON,selectEvent}` 或取消；自身只负责选择 | 推荐用于受平台拓扑约束的插入。选择结束后用当前草稿和 canonical mutation 生成一次原子编辑。 |
| `callNodePanel({position,onSelect,onClose,enableMultiAdd,...})` | 直接管理面板回调 | 用于多选添加或平台自定义选择逻辑。 |
| `call({panelPosition,fromPort,toPort,...})` | 选择后自动创建节点，可构建连线、偏移后续节点、开始拖拽 | 可用于通用编辑器；平台接入前必须验证端口与历史语义。 |

高级 `call` 支持 `canAddNode`、`customPosition`、`afterAddNode`、`enableBuildLine`、`enableAutoOffset`、`enableDragNode`、`enableSelectPosition`、`enableMultiAdd`。其 `addNode` 先创建文档节点、等待渲染，再连线/拖动；源码没有包住整次插入的统一历史事务，不能据 API 名称推定一次 Undo 就完整恢复。[公开类型](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/type.ts)、[Service 实现](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/service.ts)

各入口共用该选择器：

- **工具栏添加**：`getPosFromMouseEvent` 把按钮位置转换成画布坐标，选择后 `document.createWorkflowNodeByType`，再 `WorkflowSelectService.selectNode`。[useAddNode](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/add-node/use-add-node.ts)
- **点击输出端口**：自定义节点 wrapper 使用 `WorkflowPortRender entity={port} onClick={...}`；输入端口不弹新增面板。[NodeWrapper](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/base-node/node-wrapper.tsx)、[usePortClick](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/hooks/use-port-click.ts)
- **拖线到空白**：`FreeLayoutProps.onDragLineEnd` 接收 `fromPort/toPort/mousePos/line/originLine`，只在新连线且无目标端口时弹面板。[onDragLineEnd](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/utils/on-drag-line-end.ts)
- **连线中间插入**：新增 `@flowgram.ai/free-lines-plugin@1.0.15`，配置 `createFreeLinesPlugin({renderInsideLine:LineAddButton})`。`LineRenderProps` 给出 `line/selected/hovered/color`；按钮用 `line.center.labelX/labelY` 定位，选中后创建节点、连接前后端口、删除原线。[LineAddButton](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/line-add-button/index.tsx)
- **画布右键**：官方自定义 Layer 监听 `contextmenu`，只在非 readonly 状态打开节点面板。[ContextMenuLayer](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/plugins/context-menu-plugin/context-menu-layer.tsx)

平台建议：以上入口最终调用同一个 mutation；condition 插入必须明确原连线属于 true 或 false，以及新 condition 未使用分支的结束节点。不能直接照搬通用 `buildLine` 并默认任意输出端口均可。面板打开期间草稿仍能变更，因此接受选择时重新核对原线存在与可连接性，再一次性提交，取消不产生历史记录。

## 3. 节点菜单、选择与快捷键

官方通过 `FreeLayoutProps.shortcuts(registry,ctx)` 调用 `shortcutsRegistry.addHandlers(...)`，注册复制、粘贴、全选、删除、缩放与折叠/展开；这些 handler 是 Demo 代码，并不是仅开启 free-layout-editor 就自动得到的所有行为。[快捷键注册](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/shortcuts/shortcuts.ts)

节点菜单提供改名、创建副本、删除，并尊重 registry 的 `copyDisable/deleteDisable`；选择通过 `WorkflowSelectService` 管理。平台没有容器控制流，因此不需要复制移入/移出容器菜单。[NodeMenu](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/node-menu/index.tsx)

复制实现导出选中节点和它们之间的边；粘贴实现生成新 ID、偏移布局、批量导入、选中新节点并把焦点还给画布。其引用替换只识别 Demo 自身格式，平台 `nodes.<id>.*` 和模板中的引用必须另做确定性重写；不能简单拷贝节点 JSON 之后只替换顶层 id。[CopyShortcut](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/shortcuts/copy/index.ts)、[PasteShortcut](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/shortcuts/paste/index.ts)、[官方 ID 替换](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/shortcuts/paste/unique-workflow.ts)

建议首先实现局部创建副本与删除的相同命令入口，再实现跨节点剪贴板；输入框及编辑器文字选中时保留浏览器文本快捷操作。复制后产生的未连接节点是草稿状态，发布仍需要完整拓扑校验。

## 4. 表单物料和变量编辑：保留 AntD 6 的最小方案

官方 Start 的 formMeta 根据 `useIsSidebar()` 在画布上渲染 `DisplayOutputs`，在侧栏渲染 `JsonSchemaEditor`；End 同样区分 `DisplayInputsValues` 和 `InputsValues`。这比一个大按钮只显示 label/id 更适合业务编排：节点卡片用于理解，侧栏用于详细修改，两者共用原生 Form。[Start formMeta](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/nodes/start/form-meta.tsx)、[End formMeta](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/nodes/end/form-meta.tsx)

`@flowgram.ai/form-materials` 提供 `VariableSelector`、`DynamicValueInput`、`JsonSchemaEditor`、`PromptEditorWithVariables`、`DisplayInputsValues`、`DisplayOutputs`，并导出变量输出、重命名和重新校验的 effects。它依赖 Semi、CozeEditor、CodeMirror；只需要变量树时无需全量引入这些编辑器。官方推荐需要更换底层 UI 时取得物料源码并定制。[物料导出](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-materials/src/index.ts)、[npm 实际依赖](https://registry.npmjs.org/@flowgram.ai%2Fform-materials/1.0.15)、[官方使用方式](https://flowgram.ai/materials/introduction)

此外官方已经有 **`@flowgram.ai/form-antd-materials@1.0.15`**；npm 发布依赖 `antd ^5.25.4`、`@ant-design/icons 5.x`，并非平台的 AntD 6。固定提交的 package.json 仍写 0.1.8，因此包版本必须以 npm 发布元数据为准，不能据仓库文本推断“没有 1.0.15”。建议参考其源码，以平台现有 AntD 6 替换组件，避免引入第二套 AntD。[AntD 物料源码](https://github.com/bytedance/flowgram.ai/tree/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-antd-materials)、[npm 1.0.15 元数据](https://registry.npmjs.org/@flowgram.ai%2Fform-antd-materials/1.0.15)

最小落地建议：

1. 在现有 `workflow-variables.ts` 已有 scope 来源上，生成按上游节点分组的树；递归对象属性，节点标题用业务 label，字段同时显示类型和可能为空状态。保留 `workflowVariableIssue` 的完整可见性与 optional 祖先检查，UI 截断不成为权限/类型判断来源。
2. 使用 AntD 6 `TreeSelect`，树节点 `value` 明确是平台字符串路径；`input.x` 与 `nodes.<id>.x` 仅在变量 engine 边界转换成 keyPath。模板插入保留当前 `${...}` 语法。
3. 同官方算法，类型不匹配但有匹配子项的父节点仍保留为分组并禁选；匹配类型作为选择辅助，不能代替服务端 JSON Schema 校验。
4. 失效引用保留原路径并显示原因；不要因候选列表变化自动选择第一个变量。搜索同时匹配业务节点名称、字段名和路径。

参考算法来源：[AntD useVariableTree](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-antd-materials/src/components/variable-selector/use-variable-tree.tsx)、[Semi useVariableTree](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-materials/src/components/variable-selector/use-variable-tree.tsx)、[平台已有变量边界](../../apps/console/src/workflow-variables.ts)。AntD 源码采用 `useScopeAvailable`，较新通用物料使用 `useAvailableVariables`；本轮已有 FlowGram scope 可用，无需为了换呈现层迁移全部变量实现。

不能原样照搬的细节：官方 AntD `VariableSelector` 声明 `value?:string[]`，其 TreeSelect 数据却使用点分字符串且直接透传 onChange；`readonly/hasError/config` 等参数也没有完整传入底层 TreeSelect。平台必须明确自己的 value/onChange 类型，并实际接入禁用、错误、占位及清空行为。[AntD VariableSelector 实现](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-antd-materials/src/components/variable-selector/index.tsx)

`PromptEditorWithVariables` 在 PromptEditor 内接入变量树和标签扩展；其值是 FlowGram `type:'template',content` 结构，并非平台 `kind:'template',template`。后续接入需明确适配值结构及模板语法，不得以简单字符串替换破坏转义文本。[PromptEditorWithVariables](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-materials/src/components/prompt-editor-with-variables/index.tsx)、[PromptEditor](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/materials/form-materials/src/components/prompt-editor/editor.tsx)

## 5. 运行面板与 Mastra 的关系

官方节点状态条按 node ID 订阅 runtime service 的 `onNodeReportChange` 和 reset；编辑器 `isFlowingLine` 委托运行服务判定连线动画；试运行面板具有输入表单/JSON 切换、运行/取消和结果区域。这些呈现方式可以复用，数据适配由平台负责。[NodeStatusBar](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/testrun/node-status-bar/index.tsx)、[编辑器配置](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/hooks/use-editor-props.tsx)、[TestRunSidePanel](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/testrun/testrun-panel/test-run-panel.tsx)

平台实施建议：已发布 workflow release ID → 真实 run ID → Mastra 执行事件/节点结果 → 画布节点状态及详情。用户可以明确区分草稿、发布版本和正在查看的运行版本；编辑后的草稿不能直接覆盖历史运行映射。节点正文、工具结果与模型内容仍通过既有授权规则取得。暂未取得节点事件的状态应显示未知/无数据，不能按线条顺序播放模拟成功。

不新增 FlowGram Runtime，也不为了复刻 Demo 添加平台尚不支持的循环、汇合、并行、子画布等执行节点。平台当前 canonical/编译器支持的 start/end/tool/agent/map/condition 保持唯一可发布集合。[平台定义](../../packages/contracts/src/workflow-definition.ts)、[执行 ADR](../adr/0001-flowgram-authoring-mastra-execution.md)

## 6. 依赖与验收边界

| 能力 | 依赖/API 状态 | 本次建议 |
| --- | --- | --- |
| 文档、表单、变量、选择、快捷键注册、端口 renderer | 已有 `free-layout-editor@1.0.15` | 使用现有版本；保留上一轮修复过的历史事务与表单导出。 |
| 节点面板 | 新增 `free-node-panel-plugin@1.0.15` | 用公开选择服务，自定义 AntD 渲染及平台 mutation。 |
| 连线插入按钮 | 新增 `free-lines-plugin@1.0.15` | 有 `styled-components >=5` peer，按实际 lockfile解析统一依赖。 |
| 面板工作区 | 新增 `panel-manager-plugin@1.0.15` | 统一节点、AI、运行面板；按窗口确定 dock/floating 位置。 |
| 变量树/字段摘要 | 现有 AntD 6 + FlowGram scope | 参考官方 AntD 物料移植必要源代码；不安装 AntD5 物料整包。 |
| 完整 Prompt/Schema 物料 | 官方包可用，但需要值协议与 UI 适配 | 独立实现并验收，不能仅以已经开启 Form 宣称具备。 |
| 运行可视反馈 | 官方 Demo 有呈现组件，平台须接 Mastra | 只映射真实执行数据；不接第二套执行引擎。 |

版本依据：[node-panel npm](https://registry.npmjs.org/@flowgram.ai%2Ffree-node-panel-plugin/1.0.15)、[lines npm](https://registry.npmjs.org/@flowgram.ai%2Ffree-lines-plugin/1.0.15)、[panel-manager npm](https://registry.npmjs.org/@flowgram.ai%2Fpanel-manager-plugin/1.0.15)。这些包的 React peer 范围允许 `>=16.8`，这不等于整个 Demo 在 React19/AntD6 下均已浏览器验收。

本轮体验验收应包含：打开工作流时节点文字可读；侧栏开关不重置用户视口；连续点击不同节点无需关闭遮罩；端口添加与连线插入都可一次 Undo 完整恢复；取消物料选择没有残留节点；条件分支端口和下游引用保持正确；树形变量只展示当前 scope；菜单/快捷键不抢输入框文本操作；保存后刷新与原发布执行链均可用。布局四尺寸、真实鼠标操作和保存往返应分别记录，不以通过类型检查或截屏替代这些行为。

## 官方体验入口说明

官网“自由布局 → 最佳实践”通过 React lazy import 将 `@flowgram.ai/demo-free-layout` 嵌入文档页，没有独立 iframe 地址。此次在官网 README、文档组件和部署工作流中未确认另一个独立官方最佳实践部署 URL；不要猜测一个地址作为依据。可以使用官方 scaffold 在隔离临时目录运行完整 Demo。[文档组件](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/docs/components/free-feature-overview/index.tsx)、[官方页面源码](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/docs/src/zh/examples/free-layout/free-feature-overview.mdx)
