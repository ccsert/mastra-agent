# FlowGram 文档装载、编辑与序列化源码核查

核查日期：2026-09-07。范围：给 FlowGram → 平台发布契约 → Mastra 的局部往返实验提供固定版本事实；不选择最终画布模式、表单体系或完整控制流，不引入 FlowGram Runtime。

## 固定版本与证据

- 官方 npm 当前 `@flowgram.ai/free-layout-editor` 为 **1.0.15**，`gitHead` 为 `ba1a9630f80263a196d31993cd85fd1c873d9ddd`；其内部 FlowGram 依赖固定为 `1.0.15`，React/ReactDOM peer 均为 `>=16.8`。这不等于所有 React 版本均已验收。[npm 版本元数据](https://registry.npmjs.org/@flowgram.ai%2Ffree-layout-editor/1.0.15)
- npm 主包 integrity 为 `sha512-rLLILr3Mc/yrNxSv6k2RD8OZvrB5a549CCzGgxudTzC0DQo1tAY6pZXCGPqMtI3i/k2uA9DAkPsuA7/bm08TNA==`；本文读取了官方 tarball，并将九个相关 `sourcesContent` 与上述固定提交逐字节比较一致：Provider、node-serialize、WorkflowDocument、WorkflowLineEntity、editor-default-preset、free-history-manager、changes/index、change-content-handler、FlowNodeFormData。没有将这种局部比较扩大为整仓一致性证明。[官方发布包](https://registry.npmjs.org/@flowgram.ai/free-layout-editor/-/free-layout-editor-1.0.15.tgz)
- 最小 Vite 示例由 `FreeLayoutEditorProvider` 包裹 `EditorRenderer`，导入官方 CSS；官方示例有表单与可选 minimap/snap 插件，纯文档实验可去掉这些插件。Provider 的 `ref` 直接暴露 `FreeLayoutPluginContext`；子组件也可用 `useClientContext()`。配置在 Provider 初始化时生成，替换 `initialData` prop 不能当作重新加载命令。[固定提交 Vite 示例](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-vite/src/editor.tsx)、[Provider 实现](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/components/free-layout-editor-provider.tsx)

## 公开接口与容易误判的行为

| 事项 | 固定版本行为及实验含义 |
| --- | --- |
| `ctx.document.fromJSON(json)` | 批量增加/更新节点和连线，**不会删除 json 中未出现的已有节点**。从空文档装载可用；切换整份草稿不能只调用这个方法。 |
| `ctx.operation.fromJSON(json)` | 在增加/更新后删除缺席的旧节点和旧连线、发出已有节点的位置变化事件；开启 history 时包装为 transaction。但默认 operation 与位置历史监听的服务实例不同，不能因此认定已有节点位置或纯 data 修改全部可撤销，也不是服务器的原子发布操作。 |
| `ctx.document.toJSON()` | 输出 `{nodes, edges}`；不保存文档顶层任意扩展。文档已 dispose 时会抛错。 |
| 节点数据 | `nodeEngine: {enable:false}` 时，预设将 `json.data` 存入 `node.updateExtInfo(data,true)`，再由 `node.getExtInfo()` 导出。因此保存纯 JSON 业务数据不要求 formMeta。 |
| 表单数据 | 开启 nodeEngine 后走 `FlowNodeFormData` 与 registry.formMeta；没有 formMeta 不能据纯数据路径推定数据仍会保留。表单导出可被 `formatOnSubmit` 改写。 |
| 位置与 metadata | 普通节点默认导出 `id/type/meta.position/data`；任意 `meta` 字段、其他节点顶层字段并非透明保存。需保存额外字段时，使用明确的平台封装或 `fromNodeJSON/toNodeJSON` 扩展，并验证往返。 |
| 连线 | JSON 使用 `sourceNodeID/targetNodeID/sourcePortID/targetPortID`，可带 `data`；空端口字段导出时移除。导出不带独立线 id，因此平台不能以画布内部线 id 作为稳定执行身份。 |

上表分别依据 [WorkflowDocument](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/workflow-document.ts)、[WorkflowOperationBaseService](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/service/workflow-operation-base-service.ts)、[node-serialize](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/preset/node-serialize.ts)、[表单装载](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/utils/flow-node-form-data.ts)、[表单导出](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/node-engine/node/src/form-model-v2.ts)、[连线导出](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/entities/workflow-line-entity.ts)。

## 最小初始化参考

下面是按公开接口缩减的示意，实际运行结果以另行保存的实验为准。`initialData` 为 `{nodes,edges}`；节点位置放在 `meta.position`，节点类型必须与 registry 对应。命名端口放在 `meta.defaultPorts` 并与连线端口 ID 一致。[节点 registry 示例](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-vite/src/node-registries.ts)、[初始数据示例](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/apps/demo-vite/src/initial-data.ts)

```tsx
import { useRef } from 'react';
import {
  FreeLayoutEditorProvider, EditorRenderer, WorkflowNodeRenderer,
  type FreeLayoutPluginContext,
} from '@flowgram.ai/free-layout-editor';
import '@flowgram.ai/free-layout-editor/index.css';

function Editor({ initialData }) {
  const ctxRef = useRef<FreeLayoutPluginContext>(null);
  return <FreeLayoutEditorProvider
    ref={ctxRef}
    initialData={initialData}
    nodeRegistries={[{ type: 'tool', meta: {
      defaultPorts: [{ type: 'input' }, { type: 'output' }],
    }}]}
    nodeEngine={{ enable: false }}
    history={{ enable: true }}
    materials={{ renderDefaultNode: ({ node }) =>
      <WorkflowNodeRenderer node={node}>
        {node.getExtInfo().title}
      </WorkflowNodeRenderer>
    }}
  >
    <EditorRenderer style={{ width: '100%', height: 600 }} />
  </FreeLayoutEditorProvider>;
}
```

业务字段修改使用 `ctx.document.getNode(id).updateExtInfo(nextData,true)`。位置需要撤销时，本次 **1.0.15 实验**使用从编辑器包公开导出的 `WorkflowOperationBaseService`，调用 `ctx.get(WorkflowOperationBaseService).updateNodePosition(id,{x,y})`。此前仅根据继承关系推断 `ctx.operation.updateNodePosition` 会接入位置历史并不成立，浏览器已证伪：它改变坐标，但 `canUndo()` 仍为 false。不要依赖直接改普通 JSON 对象或仅改 transform 获得完整历史语义。[节点接口](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/document/src/entities/flow-node-entity.ts)、[位置操作](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/service/workflow-operation-base-service.ts)、[浏览器实验结果](../../.scratch/agent-platform/research/flowgram-roundtrip/evidence/browser-latest.json)

## Undo/redo 的边界

- history 默认未开启，必须设置 `history:{enable:true}`；启用后有 `ctx.history.undo()/redo()/canUndo()/canRedo()/clear()`，默认还注册 `meta/ctrl z` 与 `meta/ctrl shift z`，可用 `disableShortcuts` 关闭。不能在未启用时假设读取 `ctx.history` 仍有可用实例。[自由布局预设](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/preset/free-layout-preset.ts)
- 纯 data 的 `updateExtInfo` 会发 `NODE_DATA_CHANGE`，但 free-history 的变化清单只处理节点/线增删与连线数据；节点表单历史插件仅在 nodeEngine 启用且 `history.enableChangeNode !== false` 时注册。**启用 history 不等于纯 data 字段自动支持撤销**。平台若保留纯 data 方案，需补历史 operation；若采用表单方案，需验证表单映射及 formatOnSubmit 对执行字段的影响。[历史事件清单](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-history-plugin/src/changes/index.ts)、[默认预设](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/editor/src/preset/editor-default-preset.ts)
- `ctx.operation` 对应 `WorkflowOperationService` 的独立 singleton；FreeHistoryManager 监听另一个 `WorkflowOperationBaseService` singleton 的位置事件。浏览器确认二者不相等；清空历史后，默认 operation 位移没有入栈，BaseService 位移入栈，`await undo()/redo()` 分别将坐标恢复为 `{x:0,y:0}` 和 `{x:80,y:40}`。这是对指定版本与局部样例的验证，不是全部编辑历史正确的证明。[编辑器 operation 绑定](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/client/free-layout-editor/src/plugins/create-operation-plugin.ts)、[基础服务绑定](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/canvas-engine/free-layout-core/src/workflow-document-container-module.ts)、[历史监听](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-history-plugin/src/free-history-manager.ts)、[浏览器证据](../../.scratch/agent-platform/research/flowgram-roundtrip/evidence/browser-latest.json)
- 默认 **500ms 只是操作合并窗口，不是延迟入栈时间**。`pushOperation` 和 transaction 结束时提交同步更新 Undo 栈；Undo/redo 本身需要 await。可用 `history.undoRedoService.onChange` 观察 `push/undo/redo`。`history.transact(fn)` 仅接受同步回调，且内部没有 try/finally；有异常路径应显式 `startTransaction()` 并在 finally 中 `endTransaction()`。增加固定 sleep 不能修复上述服务实例差异。[历史操作基类](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/plugins/free-history-plugin/src/operation-metas/base.ts)、[HistoryService](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/common/history/src/history/history-service.ts)、[UndoRedoService](https://github.com/bytedance/flowgram.ai/blob/ba1a9630f80263a196d31993cd85fd1c873d9ddd/packages/common/history/src/history/undo-redo-service.ts)

## 对局部往返实验的建议

1. 使用独立平台执行定义及布局封装；工具/子流程固定版本放在受校验业务数据中，不依赖任意画布 metadata 透明保留。
2. 同时检查：空画布加载保存、整稿替换时旧节点删除、业务 data 修改保存、位置修改与 undo/redo、端口和连线 data 保存、未声明 metadata 的预期丢弃。
3. 输出 JSON 再交由已有发布契约编译与 Mastra 执行，对比执行摘要和合成结果；不以画布对象数量或截图作为执行语义一致的唯一证据。
4. 纯 data 字段撤销与默认 operation 位移历史缺口均需单列，不能在实验通过时称整个编辑器历史已完整。主实验已保存 17 项局部浏览器检查，覆盖上述两个边界和 BaseService 的位置 Undo/redo；这些结果不覆盖表单、真实拖动的全部路径或复杂控制流。
