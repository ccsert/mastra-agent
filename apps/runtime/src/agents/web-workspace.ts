import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentBrowser } from "@mastra/agent-browser";
import { createTool, type Tool } from "@mastra/core/tools";
import { createWorkspaceTools, LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { type ExecutionJob, z } from "@platform/contracts";
import { browserTunnel, WebTaskSandbox } from "./web-sandbox.ts";

export type ArtifactUpload = (input: {
  name: string;
  mediaType: string;
  contentBase64: string;
  toolCallId: string;
}) => Promise<unknown>;
export type WebWorkspace = Awaited<ReturnType<typeof prepareWebWorkspace>>;
const excluded = new Set(["node_modules", ".git"]);
class TaskBrowser extends AgentBrowser {
  private errors: string[] = [];
  private observed = new WeakSet<object>();
  override async ensureReady() {
    await super.ensureReady();
    const page = await this.getActivePage();
    if (!page) throw new Error("WORKSPACE_UNAVAILABLE");
    if (!this.observed.has(page)) {
      this.observed.add(page);
      page.on("pageerror", (error) => {
        this.errors.push(error.message.slice(0, 1000));
        this.errors = this.errors.slice(-20);
      });
    }
  }
  async inspect(width?: number, height?: number) {
    await this.ensureReady();
    const page = await this.getActivePage();
    if (!page) throw new Error("WORKSPACE_UNAVAILABLE");
    if (width && height) await page.setViewportSize({ width, height });
    const checks = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      imagesWithoutAlt: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
      unnamedButtons: [...document.querySelectorAll("button")].filter(
        (button) =>
          !button.textContent?.trim() &&
          !button.getAttribute("aria-label") &&
          !button.getAttribute("aria-labelledby"),
      ).length,
      headingCount: document.querySelectorAll("h1").length,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    return {
      ...checks,
      pageErrors: [...this.errors],
      coverage: "结构与溢出检查；不代替完整无障碍、性能或视觉评审",
    };
  }
}
async function checkSize(root: string) {
  let bytes = 0,
    files = 0;
  async function visit(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const target = join(path, item.name),
        stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        const destination = await readlink(target);
        if (
          target.startsWith(join(root, "node_modules")) &&
          (destination === "/opt/web/node_modules" ||
            destination.startsWith("/opt/web/node_modules/"))
        )
          continue;
        throw new Error("WORKSPACE_LIMIT");
      }
      if (stat.isDirectory()) await visit(target);
      else {
        bytes += stat.size;
        files++;
      }
      if (files > 1500 || bytes > 50 * 1024 * 1024) throw new Error("WORKSPACE_LIMIT");
    }
  }
  await visit(root);
  return { bytes, files };
}

export async function prepareWebWorkspace(
  job: ExecutionJob,
  signal: AbortSignal,
  config: { root?: string; image?: string; upload?: ArtifactUpload },
) {
  if (!config.root || !config.image || !config.upload || !job.conversationId)
    throw new Error("WORKSPACE_UNAVAILABLE");
  const taskRoot = resolve(config.root, job.conversationId),
    root = join(taskRoot, "project"),
    versionsRoot = join(taskRoot, "versions");
  await mkdir(root, { recursive: true });
  await mkdir(versionsRoot, { recursive: true });
  const sandbox = new WebTaskSandbox(`platform-web-${job.runId}`, root, config.image, signal);
  await sandbox.start();
  let tunnel: Awaited<ReturnType<typeof browserTunnel>> | undefined;
  const browser = new TaskBrowser({
    scope: "shared",
    cdpUrl: async () => {
      tunnel ??= await browserTunnel(sandbox.container);
      return tunnel.url;
    },
    excludeTools: job.snapshot.model.capabilities?.vision ? [] : ["browser_screenshot"],
  });
  try {
    await sandbox.prepareDependencies();
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox,
    });
    const tools = await createWorkspaceTools(workspace);
    const browserTools = browser.getTools();
    Object.assign(tools, browserTools);
    tools.browser_check = createTool({
      id: "browser_check",
      description:
        "设置桌面或移动视口并检查真实页面的横向溢出、图片 alt、按钮名称和已观察的 JS 错误；之后调用截图进行视觉评审。检查项有覆盖限制，不代表完整无障碍或获奖认证。",
      inputSchema: z.object({
        width: z.number().int().min(320).max(1920),
        height: z.number().int().min(480).max(1200),
      }),
      execute: async ({ width, height }) => browser.inspect(width, height),
    });
    const upload = config.upload;
    tools.workspace_publish = createTool({
      id: "workspace_publish",
      description:
        "将任务目录中的真实文件保存为可下载产物。单文件 HTML 可以在对话中预览；PNG 是截图证据，ZIP 是源码归档。先构建和检查，再发布。不会把文件名或助手文字当作文件内容。",
      inputSchema: z.object({ path: z.string().min(1).max(500) }),
      execute: async ({ path }, context) => {
        const bytes = await workspace.filesystem?.readFile(path);
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
        if (buffer.length > 5 * 1024 * 1024) throw new Error("WORKSPACE_LIMIT");
        const extension = path.split(".").at(-1)?.toLowerCase();
        const mediaType =
          extension === "html"
            ? "text/html"
            : extension === "png"
              ? "image/png"
              : extension === "zip"
                ? "application/zip"
                : extension === "json"
                  ? "application/json"
                  : "text/plain";
        return upload({
          name: path.split("/").at(-1) ?? "artifact",
          mediaType,
          contentBase64: buffer.toString("base64"),
          toolCallId: context?.agent?.toolCallId ?? "",
        });
      },
    });
    tools.workspace_checkpoint = createTool({
      id: "workspace_checkpoint",
      description:
        "保存一个不可变的候选版本及检查证据，或读取已有版本。达到验收标准后可标为最佳版本。回退时只接受已保存的版本 id。连续三版无改善时应重新分析问题，不机械跑满步数。",
      inputSchema: z.object({
        action: z.enum(["save", "list", "restore"]),
        label: z.string().max(200).optional(),
        evidence: z.array(z.string().max(1000)).max(20).optional(),
        versionId: z.string().uuid().optional(),
        best: z.boolean().default(false),
      }),
      execute: async (input) => {
        const manifestPath = join(taskRoot, "versions.json");
        const schema = z.array(
          z.object({
            id: z.string().uuid(),
            label: z.string(),
            evidence: z.array(z.string()),
            best: z.boolean(),
            createdAt: z.string(),
            files: z.number(),
            bytes: z.number(),
          }),
        );
        let versions: z.infer<typeof schema> = [];
        try {
          versions = schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (input.action === "list") return { versions };
        if (input.action === "restore") {
          const version = versions.find((v) => v.id === input.versionId);
          if (!version) throw new Error("WORKSPACE_UNAVAILABLE");
          for (const entry of await readdir(root))
            await rm(join(root, entry), { recursive: true, force: true });
          await cp(join(versionsRoot, version.id), root, { recursive: true });
          await sandbox.prepareDependencies();
          return { restored: version };
        }
        if (versions.length >= 16) throw new Error("WORKSPACE_LIMIT");
        if (input.best && !input.evidence?.length) throw new Error("WORKSPACE_UNAVAILABLE");
        const stats = await checkSize(root),
          id = randomUUID();
        await cp(root, join(versionsRoot, id), {
          recursive: true,
          filter: (source) => !excluded.has(source.split("/").at(-1) ?? ""),
        });
        const version = {
          id,
          label: input.label ?? `版本 ${versions.length + 1}`,
          evidence: input.evidence ?? [],
          best: input.best,
          createdAt: new Date().toISOString(),
          ...stats,
        };
        if (input.best) versions = versions.map((v) => ({ ...v, best: false }));
        versions.push(version);
        await writeFile(manifestPath, JSON.stringify(versions));
        return version;
      },
    });
    // Each tool result is bounded; original image bytes remain available to the
    // native screenshot tool's toModelOutput for visual evaluation.
    const screenshot = browserTools.browser_screenshot;
    if (screenshot?.execute) {
      const execute = screenshot.execute.bind(screenshot);
      const nativeModelOutput = screenshot.toModelOutput?.bind(screenshot);
      screenshot.toModelOutput = (output) => {
        const media = z.object({ data: z.string() }).passthrough().safeParse(output);
        return (
          nativeModelOutput?.(
            media.success ? { ...media.data, base64: media.data.data } : output,
          ) ?? output
        );
      };
      screenshot.execute = async (input, context) => {
        const output = await execute(input, context);
        const checked = z.object({ base64: z.string() }).passthrough().safeParse(output);
        if (checked.success) {
          const artifact = await upload({
            name: `screenshot-${Date.now()}.png`,
            mediaType: "image/png",
            contentBase64: checked.data.base64,
            toolCallId: context?.agent?.toolCallId ?? "",
          });
          const { base64, ...metadata } = checked.data;
          return { ...metadata, data: base64, mediaType: "image/png", artifact };
        }
        return output;
      };
      tools.browser_screenshot = screenshot;
    }
    // Serialize a whole read-only review against parent mutations. Each review
    // has a separate tool lane, avoiding a lock recursively acquired by its tools.
    const lane = () => {
      let tail = Promise.resolve();
      return <T>(work: () => Promise<T>) => {
        const result = tail.then(work);
        tail = result.then(
          () => {},
          () => {},
        );
        return result;
      };
    };
    const exclusive = lane(),
      reviewLane = lane();
    const readonlyWorkspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: root, contained: true, readOnly: true }),
    });
    const reviewTools = await createWorkspaceTools(readonlyWorkspace);
    for (const key of Object.keys(reviewTools))
      if (!/read_file|list_files|file_stat|grep|search/.test(key)) delete reviewTools[key];
    for (const [name, tool] of Object.entries(browserTools))
      if (
        ["browser_goto", "browser_snapshot", "browser_screenshot", "browser_scroll"].includes(name)
      )
        reviewTools[name] = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
    for (const [collection, queue] of [
      [tools, exclusive],
      [reviewTools, reviewLane],
    ] as const) {
      for (const value of Object.values(collection)) {
        const tool = value as Tool;
        if (!tool.execute) continue;
        const execute = tool.execute.bind(tool);
        tool.execute = (input, context) =>
          queue(async () => {
            signal.throwIfAborted();
            await checkSize(root);
            const output = await execute(input, context);
            await checkSize(root);
            return output;
          });
      }
    }
    return {
      withReview: exclusive,
      tools,
      reviewTools,
      root,
      browser,
      sandbox,
      instructions: `\n网页任务工作区：文件工具使用相对路径；命令在 /workspace 执行。Node、Vite、React、Python、Chromium 已安装，无外网。预装依赖已逐个链接到本地 node_modules，Vite 缓存目录可写，无需重新安装依赖。用 vite --host 127.0.0.1 > /tmp/vite.log 2>&1 & 启动预览；浏览器打开 http://127.0.0.1:5173。\n先明确验收条件，再构建、检查功能、桌面和移动截图、根据证据改进。用户的视觉目标不等于已获奖。使用 workspace_checkpoint 保存候选版本及证据；没有改善应改变方法或停止。发布单文件网页可用 vite-plugin-singlefile 内联资源后调用 workspace_publish。源码可 zip -r source.zip . -x 'node_modules/*' 'source.zip' 后发布。每次工具调用前后检查文件总量 50MiB/1500 个，单产物 5MiB，最多 16 个版本。任务达标可提前结束，达到预算或缺少能力时据实说明。`,
      async finalize() {
        for (const path of ["dist/index.html", "index.html"]) {
          try {
            const content = await workspace.filesystem?.readFile(path);
            if (!content) continue;
            const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
            if (bytes.length <= 5 * 1024 * 1024)
              await upload({
                name: path === "dist/index.html" ? "index.html" : "source-index.html",
                mediaType: "text/html",
                contentBase64: bytes.toString("base64"),
                toolCallId: "runtime-finalize",
              });
            break;
          } catch {
            /* Keep the run outcome if no deliverable exists or delivery is closed. */
          }
        }
      },
      async close() {
        await browser.close().catch(() => {});
        tunnel?.close();
        await sandbox.stop();
      },
    };
  } catch (error) {
    await browser.close().catch(() => {});
    tunnel?.close();
    await sandbox.stop();
    throw error;
  }
}
