# 模块组织与依赖规则

本轮将应用内的目录结构统一为业务模块，保留控制面、Runtime 和控制台三个独立应用。目录聚合职责，公开入口约束访问；不要求每个模块套用 controller/service/repository，也不为单个文件强建多层目录。

## 控制面

```text
apps/control-plane/src/
  app.ts                 HTTP 中间件、路由注册与组装
  platform.ts            领域依赖组装
  main.ts / migrate.ts   进程和迁移入口
  modules/
    agents/              Agent 草稿、校验与固定发布
    projects/            项目访问与管理
    resources/           模型/工具资源、执行凭据解析
    conversations/       会话、流式响应、Agent 运行队列
    workflows/           工作流草稿/发布、队列与路由
    knowledge/           知识库、文档、检索与任务
    skills/              版本授权、归档解析、包内文件
    mcp/                 服务登记、发现与能力导入
    identity/            用户与会话认证
    applications/        AppID 和 AK/SK
    runtimes/            Runtime 状态
  infrastructure/        加密、数据库记录映射、游标、领域错误、执行上下文
  http/                  Hono 类型和公共响应契约
```

每个业务模块的 `index.ts` 显式导出跨模块实际需要的能力。`routes.ts` 是 HTTP 组装入口，仅 `app.ts` 注册；领域公开入口不转导出路由，防止业务调用将整个 HTTP 层带入依赖图。模块内部直接导入自己的文件，其他模块使用 `../skills/index.ts` 等公开入口，不能依赖 `skills/archive.ts` 等内部实现。

业务实现可以直接持有数据库事务，不增加只转发 SQL 的仓储。事务范围、项目权限、租约与发布一致性仍归业务模块；`infrastructure/` 和 `http/` 不反向导入业务模块。项目和 Runtime 的路由也已从原混合注册函数中独立出来，注册顺序及 OpenAPI 保持不变。

## Runtime

根目录保留 `main.ts` 和任务组装入口 `worker.ts`。`agents/`、`workflows/`、`knowledge/`、`skills/`、`mcp/`、`tools/` 各自拥有执行实现；`control-plane/` 负责认证 HTTP、联系状态和轮询取消。跨模块只使用 `index.ts`。

Runtime 不导入控制面源码或数据库包。Skills 沙箱管理仍在 Skills 模块内，工作流 Agent 节点使用 Agent 模块的公开执行接口；文件移动没有改变固定版本、运行权限和 Docker 隔离配置。

## 控制台

```text
apps/console/src/
  main.tsx / vite-env.d.ts
  app/                   登录、项目切换、导航和页面/编辑器组装
    auth/
    styles/base.css
  features/
    agents/              Agent 列表与专用编辑器
    models/ tools/       各自页面、表单类型、校验和保存请求
    applications/        应用列表、编辑器和一次性凭据
    projects/            项目创建
    chat/ knowledge/ mcp/ skills/
    workflows/
      canvas/            画布交互、节点注册、文档转换与画布样式
      fields/            节点表单、提示词、变量选择与字段样式
      model/             纯编排、绑定与变量模型
      queries.ts         领域查询和取消策略
      styles.css         工作流样式入口
    overview/ runs/ runtimes/
  shared/
    data/                项目缓存、跨页面资源目录、分页与错误状态
    EditorForm.tsx       通用抽屉和提交生命周期
    api.ts / Blank.tsx / useOperation.ts / useLifetime.ts
```

`features/<name>/index.ts` 是功能公开入口；需要样式的功能通过 `styles.css` 公开，由应用入口或功能懒加载入口加载。其他功能不直接访问内部组件。`shared/` 不依赖 `features/` 或 `app/`；`features/` 不反向依赖 `app/`。导航意图类型位于 shared，菜单图标与页面组装仍在 app。

后续路由改造在 `app/routing/` 声明地址、页面组装及离开保护；`ProjectConsole` 只保留导航框架，通过 `Outlet` 渲染页面。功能模块接收资源选择意图，URL 定位与权限检查由应用层协调。路由表及刷新/历史行为见 [控制台路由说明](console-routing.md)。

原五合一 `Editors.tsx` 已删除。各功能拥有自己的表单类型、默认值与生成 SDK 请求；24 行 `EditorHost` 仅选择编辑器。通用 `EditorForm` 处理重复提交、错误、取消与迟到响应，不包含业务字段或根据 kind 切换请求。

项目资源目录确实供 Agent、概览、工作流等多个页面共用，暂留 `shared/data/ProjectData.tsx`；知识库/MCP/工作流的详情和任务查询已归入各自 `queries.ts`。该目录不承载领域写入，也不能引入业务页面。目录中的服务器搜索与查询成本仍需后续治理。

后续内容分页改动限制了共享查询入口：会话和工作流仅通过 `useProjectPages` 读取，知识库文档分页仍在知识库自己的 `queries.ts`。工作流能力读取、固定依赖筛选和本次 AI 编排范围归 `modules/workflows/catalog.ts`，保持模块内部实现。契约变化与验证另见 [能力目录与内容分页](resource-directories.md)，不改变下面第六轮迁移的历史验收记录。

样式按功能归属拆分，保留原选择器的声明及同一选择器/媒体条件内的顺序。未引入新的设计风格、移动端需求或 CSS 优先级层。功能内部有明确需要时再细分：工作流有画布、字段和页面样式，简单功能只保留一份样式。

## 契约与测试

`packages/contracts/src/index.ts` 仅负责公开导出。Agent、会话、知识库、工作流等定义放在同名文件，公共基础值放在 `common.ts`；内部文件从实际定义导入，不反向读取 index。每类定义目前适合一个文件，因此这里保留单层业务文件，不机械增加同名文件夹。`@platform/contracts` 包入口和生成 SDK 的公开接口不变。

测试结构：

- `tests/contracts/`：契约、纯编排、归档与架构规则；其中部分用例验证模块内部的稳定不变量。
- `tests/integration/`：真实 PostgreSQL、HTTP、生成 SDK 与发布/授权/租约行为。
- `tests/runtime/`：模型/MCP 协议适配、执行与真实 Docker 隔离。
- `tests/fixtures/`：模型、MCP、ZIP 合成数据和服务。
- `apps/console/tests/app/`：登录、项目与页面生命周期。
- `apps/console/tests/features/`：功能行为、分页与编辑器回归；环境在 `helpers/`。

`pnpm test` 和 `pnpm test:console` 已随目录更新。完整入口仍为 `pnpm check`。Docker 用例需要设置 `SKILL_TEST_IMAGE`；未设置时相关用例会明确跳过。

## 约束与构建

`.dependency-cruiser.cjs` 自动发现三个应用的功能目录，对新增模块应用相同公开入口规则。禁止跨模块内部访问（包括 type-only）、共享层反向依赖、领域实现引入 HTTP、非组装层注册路由，以及既有的跨应用引用、运行时循环和 Runtime 数据库访问。

`tests/contracts/architecture.test.ts` 在临时目录运行真实 dependency-cruiser，验证合法导入可通过，并故意构造私有导入、反向依赖和路由越界，逐项检查对应规则拒绝。测试不会在正在运行的应用目录插入探针文件。

六个 TypeScript 包使用 `scripts/build-package.mjs`，编译前清理各自生成的 dist。删除或移动源文件后，旧 JavaScript 和声明不会残留在独立安装包里；编译失败会使构建中止。数据库 SQL 仍在编译后复制，Runtime 独立产物仍不包含数据库或 tsx。

## 验收范围

本轮维持已有 API、发布快照与运行语义；迁移不新增数据库版本，OpenAPI 与生成 SDK 逐字一致。完整 `pnpm check` 通过，显式启用 Docker 后为 42 个后端/领域测试和 21 个 React DOM 测试，全部通过、无跳过。最后的节点注册调整又通过架构/工作流定向回归、lint、类型检查和控制台构建。

独立安装包在仓库外通过依赖隔离、SQL 迁移、生成 SDK、Mastra 工具/工作流、断线恢复、重启历史与正常退出检查。这里使用确定性模型协议样例；本轮只读核对了此前真实 Qwen 的 Skills 运行，没有据此声称新做了一轮真实模型验收。六个包的旧 dist 探针及原平铺服务产物均已清除。

CUA 在局域网地址 `http://192.168.110.151:5179/` 确认保留登录的工作台和 Runtime 已连接；随后专用标签页连接持续超时，原生通道在选择项目时返回 `native pipe closed before response`。因此编辑器、Skills 和 FlowGram 的完整视觉/交互验收仍待补做，不能用 DOM 或 API 测试代替。控制台画布仍是较大的协调模块，目录分组和接口规则也不表示整个企业平台已经达到生产交付标准。
