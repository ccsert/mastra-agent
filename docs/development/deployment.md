# 独立构建与部署

本轮交付控制面、Runtime 的编译产物与容器构建，控制台为 Vite 静态资源 + Nginx 同源 API/SSE 代理。保持 PostgreSQL 16 / pgvector 0.8.6。部署模板用于当前平台能力，不代表已完成多客户 Runtime 注册、独立凭据分配、生产高可用、TLS 证书或内容治理。

## 构建边界

- `pnpm build:services` 按契约、数据库、运行支撑包、控制面、Runtime 的依赖顺序编译。各包都有独立 `tsconfig.json` / `tsconfig.build.json`；服务用 NodeNext 输出 `.js`，数据库产物包含全部 SQL 迁移。
- `pnpm build` 继续检查全仓类型、构建生成 SDK 和控制台。开发启动/测试显式使用 `development` 导出条件读取源码；正式 `node dist/main.js` 使用包的 dist 导出。
- `pnpm bundle` 构建并生成新的 `output/release-时间戳/{control-plane,runtime}` 目录。`node scripts/bundle.mjs /指定的新目录` 仅打包已构建内容，拒绝覆盖现有目录。
- 使用 [pnpm 10 官方 deploy](https://pnpm.io/10.x/cli/deploy) 的 `--prod --legacy --frozen-lockfile`；禁用 hoist，避免复制后遗留指向原仓库的 workspace 提升链接。每份产物具有独立 node_modules。Runtime 不带平台数据库包、pg 或 tsx。
- `node --conditions=development --import tsx scripts/verify-bundles.ts /产物父目录` 验证依赖链接、数据库迁移、生成 SDK、Mastra 工具/工作流、断连/恢复、重启历史与优雅退出。需要开发 PostgreSQL，只创建并删除独立测试 schema，模型使用明确标识的确定性协议服务。

本机打包的 node_modules 只用于相同 OS/架构。交付 Linux 应在目标 Linux 架构构建，或从下述 Docker 构建导出，不将 macOS 包复制后宣称 Linux 可运行。

## Docker

在仓库根目录构建三个镜像（Node 24.13.0、pnpm 10.32.1）：

```sh
docker buildx bake -f deploy/docker-bake.hcl --load
```

部署配置单独保存在权限为 600 的文件中，不复用包含开发数据库连接的整个 `.env`。示例所需字段：

```dotenv
# 三项分别使用随机值；数据库密码用十六进制可避免连接串编码歧义。
POSTGRES_PASSWORD=<随机十六进制密码>
ENCRYPTION_KEY=<64位十六进制加密密钥>
RUNTIME_TOKEN=<随机服务令牌>
CONSOLE_ORIGIN=http://服务器地址:5179
CONSOLE_PORT=5179
CONTROL_PLANE_PORT=4110
# 通过 HTTPS 网关提供控制台时设置 true，并同步上面的精确 Origin。
COOKIE_SECURE=false
```

```sh
docker compose --env-file /安全路径/platform.env -f deploy/compose.yaml up -d --build --wait
```

控制面与 Runtime 容器用非 root 用户；数据库不暴露主机端口。控制台默认监听所有网卡，控制面默认仅映射 `127.0.0.1:4110`。跨主机 Runtime 接入时，在控制面之前配置可达的 HTTPS 网关并转发 `/internal/runtime/`；不要将令牌交给浏览器。模板只沿用当前单个配置 Runtime ID/令牌的运行契约，不提供客户注册或权限委派。

私网主机安装相同 Runtime 镜像，使用仅含 `CONTROL_PLANE_URL`、`RUNTIME_TOKEN`、`RUNTIME_ID` 的配置：

```sh
docker compose --env-file /安全路径/runtime.env -f deploy/runtime.compose.yaml up -d
```

Runtime 主动领取任务，无需为业务调用开放客户入站端口；本地健康端口只映射环回地址。模型/工具地址需能被这个 Runtime 访问，模型内容许可与私网内容代理仍按待建设清单推进。

标准 Skills 的指令读取不需要 Docker 管理权限。需要执行授权脚本时，参考 [Skills 部署与验收说明](skills.md)，预加载固定沙箱镜像并显式叠加 `deploy/runtime.skills.compose.yaml`；默认 Compose 不挂载 Docker socket。新增 Docker CLI 的 Runtime 镜像尚未完成本轮构建验收，下面记录的上一轮镜像与安装包不含 Skills 实现。

普通停止使用 `docker compose ... stop`，保留数据卷。备份必须同时保存 PostgreSQL 数据和 `ENCRYPTION_KEY`。数据库启动会执行带 advisory lock 的迁移；v5 新建分页索引，v6 新建 Skill 版本和文件表。已有大库需先在副本评估建索引锁等待与耗时，未做生产在线迁移验收。

## Linux 直接安装

在 Linux 主机执行 `pnpm bundle`，或按目标架构导出：

```sh
docker buildx build --platform linux/amd64 -f deploy/Dockerfile \
  --target linux-bundles --output type=local,dest=output/linux-amd64 .
```

将两个独立目录安装至 `/opt/agent-platform/control-plane` 与 `/opt/agent-platform/runtime`。目标主机安装 Node.js 24.13+；正式启动无需 pnpm、tsx、源码仓库或网络安装依赖。环境显式提供，不自动向上读取仓库 `.env`：

```sh
cd /opt/agent-platform/control-plane
node --env-file=/etc/agent-platform/control-plane.env dist/main.js
# Runtime 主机
cd /opt/agent-platform/runtime
node --env-file=/etc/agent-platform/runtime.env dist/main.js
```

控制面配置 `DATABASE_URL`、`ENCRYPTION_KEY`、`RUNTIME_TOKEN`、`CONSOLE_ORIGIN`，可选 `API_HOST`/`API_PORT`、`RUNTIME_ID`、`COOKIE_SECURE`、`CONSOLE_ADDITIONAL_ORIGINS`。Runtime 只配置其 URL/令牌/ID 与可选 `RUNTIME_HOST`/`RUNTIME_PORT`。私网/正式部署不启用开发专用 `CONSOLE_LOCAL_ORIGINS`。

需 systemd 时，使用 `deploy/agent-platform@.service` 模板，创建同名系统用户并授予配置读取权限，按实际 Node 路径调整 `ExecStart`；分别启用 `agent-platform@control-plane`、`agent-platform@runtime`。模板已提供，当前 macOS 验收未安装或运行 systemd。静态控制台另交由 Nginx 托管，参考 `deploy/nginx.conf`，适配控制面地址并保留 SSE 禁止缓冲的设置。

## 诊断与故障语义

- 控制面 `/health` 与 `/ready` 检查数据库；Runtime `/health` 只表明进程存活，`/ready` 需要最近 15 秒内成功通过认证连接控制面，失去网络/权限时返回 503，恢复后返回 200。这不等同于模型、知识库或所有业务工具可用。
- HTTP 响应带 `X-Request-Id`；Runtime 控制请求传递相同标识，失败可跨两个进程关联。它与运行幂等键不同。日志只记录服务、事件、路由模板、状态、耗时及必要 ID，不输出请求正文、查询字符串、Cookie、令牌或 Error 原文。
- 成功的内部高频请求不写 HTTP 日志，运行详情仍由现有持久化记录提供。当前不是完整审计日志或分布式 tracing。
- SIGTERM/SIGINT 停止领取任务与清理调度；控制面等待已有连接和清理完成后关闭数据库，Runtime 中止执行并尽力回报终态。未能回报的任务仍通过已有租约超时收敛，不承诺自动重放业务写入。容器停止宽限为 30 秒。

远端 CI 尚未配置；`pnpm check` 与仓库外产物验证是本地交付证据。镜像发布到仓库、生产 TLS/备份恢复演练、Linux amd64 与目标客户网络验收仍需在各自环境完成。

## 本轮本地产物（2026-09-09）

已从实际运行验收的 Linux ARM64 镜像导出 `output/releases/agent-platform-linux-arm64-20260909.tar.gz`（44 MiB），只包含控制面与 Runtime 的独立安装目录，不含配置密钥或数据库数据。SHA-256：`3fc69b647aa162dd0f4514fbef237df14005c764f01e3afe14ba0753625ab48d`。控制面57条、Runtime659条依赖链接全部位于各自产物内部。

最终本地镜像 ID（未推送镜像仓库）：

- control-plane：`sha256:0c371588020ef5824034054096ca4e4a67b8d0add61b44ea8ae526e2077a9e19`
- runtime：`sha256:dc073de8442c8652c620a02b45c6540dfab5680c2dd02bafc05eb0d6ec2b89b4`
- console：`sha256:a8ad202e866d1f37e5ddb0c7db29f975900bee4adcd17b4268a78264fa4b7dea`

在独立 Compose 项目 `agent-platform-architecture-20260909` 验收；最终镜像替换后再次通过登录、历史读取和新工作流执行。验收完成后停止该项目，保留其合成数据卷。常用开发服务仍位于局域网5179入口，二者使用独立数据库。
