# FlowGram 交互差异核查：显隐、定位与布局

核查日期：2026-09-08。对象为整改开始时的本仓工作台，以及本项目锁定的 FlowGram 1.0.15。官方源码固定到 `ba1a9630f80263a196d31993cd85fd1c873d9ddd`；同时核对本地安装包的 ESM 与声明文件。本文是源码研究，不是浏览器验收报告；本轮没有使用浏览器或 Playwright，也没有修改产品代码。

## 结论

用户指出的三处问题均存在实质实现差异。连线加号常驻来自本仓主动设置的 `opacity: 0.5`；弹窗位置偏移来自混用节点放置点与面板锚点，并漏掉画布缩放；自动布局只用于手动按钮，初始化、AI 候选与插入仍由本仓手写坐标控制。此前“按官方最佳实践重做”的表述超过了实际完成程度。

应采用官方现有的连线状态、节点面板锚点、布局服务及历史事务。不能只修改三个视觉常量后声称体验已经对齐。

## 1. 连线加号默认不渲染

官方 `LineAddButton` 的 `useVisible` 依次检查：

1. `line.disposed` 时返回 false，且必须先于读取 `fromPort/toPort`，避免销毁后的端口副作用。
2. 只读画布返回 false。
3. `!selected && !hovered` 时返回 false。
4. 只有选中或悬停连线时才渲染加号。

来源：[use-visible.ts:15-27](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/line-add-button/use-visible.ts#L15-L27)、[LineAddButton:111-128](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/line-add-button/index.tsx#L111-L128)。

`hovered/selected` 已由 `WorkflowLinesLayer` 订阅 `onSelectionChanged`、`onHoveredChange` 并作为 `LineRenderProps` 传给 `renderInsideLine`。连线 memo 的版本串也包含这两个状态，无需再写一套 DOM hover 检测。来源：[workflow-lines-layer.tsx:71-81](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-lines-plugin/src/layer/workflow-lines-layer.tsx#L71-L81)、[128-161](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-lines-plugin/src/layer/workflow-lines-layer.tsx#L128-L161)。

本仓整改前的 `WorkflowMaterials.tsx:207-232` 无条件返回按钮，只改变 `active` 类；`workflows.css` 将默认透明度设置为 0.5。因此并非 FlowGram 缺乏自动显隐，而是本仓绕开了已经提供的状态。

推荐直接保留 `createFreeLinesPlugin({ renderInsideLine })`，在 renderer 内采用官方显隐判断。隐藏时不留透明的可点击、可聚焦按钮。选中连线后加号继续显示属于官方行为，不应误判成 hover 离开后未隐藏。

## 2. 节点面板使用画布内锚点与弹层定位

### 官方区分面板锚点和节点位置

连线中的按钮渲染于 `line.center.labelX/labelY`；点击后的面板锚点为线的起止端点中点。选择类型后，才调用 `WorkflowNodePanelUtils.adjustNodePosition` 计算新节点位置。两者不共用一个带有任意 `-60` 的坐标。来源：[LineAddButton:39-73](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/line-add-button/index.tsx#L39-L73)。

端口点击使用 `playground.config.getPosFromMouseEvent(e)` 作为面板位置；新节点位置才根据端口朝向加 100，并交给 `adjustNodePosition` 按节点注册尺寸调整。来源：[use-port-click.ts:63-103](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/hooks/use-port-click.ts#L63-L103)。

拖线到空白同样区分面板锚点与新节点位置；示例还可以显示节点占位框。来源：[on-drag-line-end.ts:31-81](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/utils/on-drag-line-end.ts#L31-L81)。

### 官方 renderer 不把逻辑坐标直接当 body 的 fixed 坐标

`WorkflowNodePanelLayer` 原样传递 `position`，画布层自身响应 `onZoom` 设置 `scale(zoom)`。示例 `NodePanel` 在该层中放置 `position: absolute; left: position.x; top: position.y` 的零尺寸锚点，然后让 Popover 以 `placement="right"`、`offset: [30, 0]` 定位实际内容。占位模式使用 360 × 100 的锚点。来源：[layer.tsx:38-53](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/layer.tsx#L38-L53)、[node-panel/index.tsx:22-63](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/node-panel/index.tsx#L22-L63)。

本仓将 palette portal 到 `document.body`，调用 `config.toFixedPos(position)` 后设置 fixed 坐标。1.0.15 的准确语义如下：

```text
getPosFromMouseEvent:
canvasX = (clientX + scrollX - canvasClientRect.x) / zoom

toFixedPos:
clientX = suppliedX - scrollX + canvasClientRect.x
```

`toFixedPos` **没有乘 zoom**。因此它不能直接作为 `getPosFromMouseEvent` 对未缩放逻辑坐标的逆变换。若保留 body portal，必须先乘 zoom；当前实现会在非 100% 缩放时偏移。来源：[playground-config-entity.ts:246-280](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/core/src/core/layer/config/playground-config-entity.ts#L246-L280)。

本仓还存在三处额外偏离：

- 连线插入将 `line.center.labelY - 60` 同时用于新节点和弹窗；这个 60 没有考虑实际节点高度。
- 端口点击将 `node.transform.bounds.right + 100, bounds.y` 同时作为二者位置；条件节点两个输出端口因此失去各自的真实 y 坐标。
- fixed 面板靠 `innerHeight - 490`、`innerWidth - 308` 做静态夹取。面板高度会随过滤结果、提示文本、字体和可用空间改变；搜索后可能远离锚点，窗口或画布变化后也没有可靠重定位。

推荐保留官方 NodePanelService/Layer，在层中渲染真实锚点，使用项目的 AntD 6 Popover 承担实际内容的测量、翻转与边界调整。`panelPosition` 与 `nodePosition` 应在接口上分开。可以保留自己的节点目录与业务资源校验，不能因此重写画布坐标系统。

示例调用处传入 `enableScrollClose: true`，但固定版本的 NodePanel renderer 与 NodePanelLayer 本身没有消费该字段。不能仅添加这个 prop 就宣称滚动画布时会自动关闭。应实测所选 Popover 在画布平移/缩放时的锚点更新，或显式订阅视口变化关闭弹层。

## 3. 布局应采用已有引擎，且区分全图布局与局部插入

### 全图布局

`ctx.tools.autoLayout(options)` 调用官方 `AutoLayoutService`，并记录节点变化前后的坐标到 `FreeOperationType.dragNodes`。preset 已安装自动布局插件，不需要为了接入布局再安装第二套算法。来源：[tools/auto-layout.ts:23-48](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/tools/auto-layout.ts#L23-L48)、[75-94](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/tools/auto-layout.ts#L75-L94)。

服务使用节点 `transform.bounds` 的真实宽高、节点之间的边及容器结构建立布局数据；默认配置为 `rankdir: LR`、`ranksep: 100`、`nodesep: 100`、`edgesep: 10`、`ranker: network-simplex`。这是尺寸加间距的图布局，不能用“每一层 x 加 380，每个分支 y 加 280”替代。来源：[services.ts:87-115](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-auto-layout-plugin/src/services.ts#L87-L115)、[layout/constant.ts](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-auto-layout-plugin/src/layout/constant.ts)。

```ts
await ctx.tools.autoLayout({
  layoutConfig: {
    rankdir: "LR",
    ranksep: 100,
    nodesep: 100,
    edgesep: 10,
    ranker: "network-simplex",
  },
  disableFitView: true,
  enableAnimation: false,
});
```

布局服务默认还会 fitView。若业务在布局后另行控制视口，应设置 `disableFitView: true`；否则会出现重复 fit 和额外缩放。来源：[services.ts:37-56](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-auto-layout-plugin/src/services.ts#L37-L56)。

### 官方插线使用基于尺寸的局部避让

官方插线示例使用 `WorkflowNodePanelUtils.adjustNodePosition`、`subNodesAutoOffset`、`buildLine`，并非每插入一个节点都运行全图 Dagre。局部偏移根据起止节点 bounds、新节点注册 size（不存在时取测量 bounds）、padding 与二维矩形间距计算，只在空间不足时移动后继节点。来源：[LineAddButton:64-108](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-free-layout/src/components/line-add-button/index.tsx#L64-L108)、[sub-position-offset.ts:26-95](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/utils/sub-position-offset.ts#L26-L95)。

更高层的 `WorkflowNodePanelService.call` 也已提供 `fromPort`、`toPort`、`customPosition`、`enableAutoOffset`、`enableBuildLine`、`autoOffsetPadding`。但平台有条件节点补 false 结束分支、canonical DSL 等约束，不能直接不加适配地让该方法创建任意图。可以使用官方底层 utility，或者明确选择“结构编辑完成后统一全图布局”的平台策略。后者满足用户要自动算法的要求，但应准确说明它属于平台策略。来源：[type.ts:12-40](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/type.ts#L12-L40)、[service.ts:165-221](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-node-panel-plugin/src/service.ts#L165-L221)。

### 本仓必须统一的路径

以下位置是核查开始时的代码入口；后续整改可能改变行号。

| 路径 | 原实现 | 应有行为 |
| --- | --- | --- |
| `workflow-model.ts:autoPositions` | DFS，固定 380/280 | 删除作为权威布局来源的用途 |
| `WorkflowCanvas.tsx:documentFor` | 在加载文档时补 DFS 坐标 | 完整有效持久布局可保留；无布局文档在节点测量后调用官方布局 |
| `Workflows.tsx:draftOf` | DFS 与服务器 layout 合并 | 不在数据转换层伪造最终布局 |
| AI 候选预览 | `layout: autoPositions(...)` | 只读候选也使用同一官方布局服务；readonly 不应阻止初始化显示布局 |
| AI 接受候选 | `replace(next)` 后仅延迟 fit | 文档创建、测量与布局完成后再展示；更新草稿状态与持久化语义明确 |
| `workflow-editing.ts:insertWorkflowNode` | 新节点位置加固定 380，后继仅 x 平移，额外结束节点 y 加 280 | 图结构与布局分离，使用官方局部避让或统一布局服务 |
| 工具栏自动布局 | 已调用官方服务，然后重复 fit | 统一布局选项，保留一次清晰的视口操作 |
| 粘贴/拖入空白 | 固定 offset 是用户摆放意图 | 保留用户指定位置不等于算法缺失；只在自动布局操作或结构变化策略要求时重排 |

导入、插入与布局必须作为同一次用户动作进入 History。`fromJSON` 和 `await tools.autoLayout` 若各自独立，撤销可能只撤坐标而不撤结构。测量完成前立即布局则可能使用零高度或默认尺寸。初始化布局也不能悄悄覆盖用户已经保存的人工位置或把每次打开都标记为未保存；旧版手写布局如需统一迁移，需明确区分迁移、预览和草稿修改。

## 4. 直接浏览器回归验收清单

以下均是待实现后验收项，本文未声称已通过。应使用用户要求的直接浏览器控制能力，不使用 Playwright。

1. 初始画布没有常驻连线加号；悬停单条线仅显示对应加号，移出未选中线后消失；选中线则保持显示；只读候选完全无编辑加号。
2. 在 50%、100%、150% 缩放和平移后点击连线加号，面板仍靠近触发点；分别点击条件节点 true/false 端口，锚点对应实际端口。
3. 在屏幕四边与打开右侧配置栏时唤起面板；面板不越界、不盖住触发对象，不靠固定 490px 高度预测。搜索变短和变长时位置仍合理。
4. 面板打开后平移、缩放或调整窗口，明确验证锚点随动或面板关闭；Escape/点击外部关闭；一次操作只有一个活动面板。
5. 无 layout 的新建/AI 候选、主路径插入、分支插入与额外结束节点使用同一明确布局策略；多行高节点不重叠，间距由布局配置与真实尺寸产生。
6. 一次撤销同时恢复节点、连线和旧坐标；重做恢复布局结果。保存并重新打开布局一致。用户已保存的人工位置按明确策略保留。
7. 画布缩放与右侧配置面板、AI 面板的开关互不意外重置。由初始化或布局产生的草稿变更不被误报“已保存”。

范围边界：此次研究处理编排交互；不改变 FlowGram 编排、Mastra 执行的边界，也不借此引入尚未被执行器支持的并行、循环或子流程节点。
