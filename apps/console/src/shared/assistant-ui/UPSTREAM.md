# assistant-ui Elements 来源与维护

本目录按官方 Elements 的源码引入方式维护。来源为 [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui/tree/3a45a01c0d6141102638ecd4f32d1af4d01fb510)，固定提交 `3a45a01c0d6141102638ecd4f32d1af4d01fb510`，引入日期 2026-09-09，MIT 许可证见同目录 `LICENSE`。

| 本地文件 | 官方仓库路径 |
| --- | --- |
| `elements/composer-trigger-popover.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/composer-trigger-popover.aui.tsx` |
| `elements/tool-fallback.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/tool-fallback.aui.tsx` |
| `elements/tool-group.aui.tsx` | `packages/ui/src/components/react/assistant-ui/elements/tool-group.aui.tsx` |
| `elements/reasoning.tsx` | `packages/ui/src/components/react/assistant-ui/elements/reasoning.tsx` |
| `ui/{button,collapsible,textarea}.tsx` | `packages/ui/src/components/react/ui/radix/` 下同名文件 |
| `utils.ts` | `packages/ui/src/lib/utils.ts` |

本地适配：调整相对导入路径、常用展示文案中文化、使用安全回退代替非空断言、按本项目格式化。保留官方组件结构、交互 hook、状态处理和 utility classes。未使用兼容旧 API 的 ToolGroup 包装；Chat 通过 `MessagePrimitive.GroupedParts` 组合 Root/Trigger/Content。

`styles.css` 是本项目接入文件：只扫描上述 Elements/UI 的 Tailwind utilities，不引入全局 Preflight；带入官方 registry 的 data-open/data-closed variants、折叠动画、tw-animate-css 和 tw-shimmer。颜色映射到平台主题；组件容器内补充按钮基础样式、快捷菜单宽高与长结果滚动。未引入官方全站 body/reset 样式。

Skill 版本候选、数量上限、选中 IDs 和 `/skill 多词查询` matcher 留在 Chat feature；键盘、Escape、IME 和选择移除行为由官方 Composer 实现。授权与取消继续走现有服务端契约。ToolFallback 中保留的可选审批 UI 不代表平台已经接通该审批协议；平台当前没有把审批事件接入此组件。

升级时先比较固定上游文件和 registry 样式，再核对安装包 API；重点回归指令选择不发送消息、不丢正文、工具分组折叠、失败详情与历史恢复。当前 `@assistant-ui/react` 固定为 `0.15.18`，Trigger API 仍标为 unstable。调研记录见 `docs/research/assistant-ui-component-reuse-2026-09-09.md`。
