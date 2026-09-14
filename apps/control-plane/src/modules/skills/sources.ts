import { createHash } from "node:crypto";
import {
  type SkillDiscovery,
  SkillPath,
  type SkillRemoteSource,
  type SkillSourceInput,
  z,
} from "@platform/contracts";
import JSZip from "jszip";
import { parseDocument } from "yaml";
import { ApiError } from "../../infrastructure/errors.ts";
import { importSkillArchive } from "./archive.ts";

const invalid = (message: string) => new ApiError(400, "SKILL_SOURCE_INVALID", message);
const unavailable = (message: string) => new ApiError(503, "SKILL_SOURCE_UNAVAILABLE", message);
const hash = z.string().regex(/^[a-f0-9]{40}$/);
const entrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: hash.optional(),
  id: hash.optional(),
  size: z.number().optional(),
});
type Entry = z.infer<typeof entrySchema>;
const segment = /^[a-zA-Z0-9_.-]+$/;
const pathOK = (path: string) => !path || SkillPath.safeParse(path).success;
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function parseSkillSource(input: SkillSourceInput) {
  let address = input.url.trim();
  if (/^[\w.-]+\/[\w.-]+(?:@[\w.-]+)?$/.test(address)) {
    const [repo, skill] = address.split("@");
    address = skill ? `https://skills.sh/${repo}/${skill}` : `https://github.com/${repo}`;
  }
  // Validate before URL normalization can erase traversal segments.
  if (/[\\\s]/.test(address) || address.split("/").some((p) => /^(?:\.|%2e){1,2}$/i.test(p)))
    throw invalid("来源地址包含无效路径");
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid("请输入 GitHub、GitLab.com 或 skills.sh 的 HTTPS 链接，也可填写 owner/repo");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw invalid("请使用不含凭据、查询参数或片段的 HTTPS 来源链接");
  const host = url.hostname;
  if (!["github.com", "gitlab.com", "skills.sh", "www.skills.sh"].includes(host))
    throw invalid("当前支持公开 GitHub、GitLab.com 与 skills.sh 来源；私有仓库可先上传 ZIP");
  let parts: string[];
  try {
    parts = url.pathname
      .replace(/^\/|\/$/g, "")
      .split("/")
      .map(decodeURIComponent);
  } catch {
    throw invalid("来源地址编码不合法");
  }
  const kind = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : "skills-sh";
  let ref = "HEAD",
    path = "",
    selector: string | undefined;
  const marker = kind === "gitlab" ? parts.indexOf("-") : 2;
  const repoParts =
    kind === "gitlab" ? (marker < 0 ? parts : parts.slice(0, marker)) : parts.slice(0, 2);
  if (repoParts.length < 2 || repoParts.some((p) => !segment.test(p) || p === "." || p === ".."))
    throw invalid("来源需要完整的仓库所有者与名称");
  repoParts[repoParts.length - 1] = repoParts[repoParts.length - 1].replace(/\.git$/, "");
  if (!repoParts.at(-1)) throw invalid("仓库名称不能为空");
  const repository = repoParts.join("/");
  if (kind === "skills-sh") {
    if (parts.length !== 3 || !segment.test(parts[2]))
      throw invalid("请粘贴 skills.sh 的具体 Skill 详情链接");
    selector = parts[2];
  } else {
    const rest = kind === "gitlab" ? (marker < 0 ? [] : parts.slice(marker + 1)) : parts.slice(2);
    if (rest.length) {
      if (!["tree", "blob"].includes(rest[0]) || !rest[1])
        throw invalid("请使用仓库链接，或包含 tree/ref/目录 的 Skill 链接");
      ref = rest[1];
      path = rest
        .slice(2)
        .join("/")
        .replace(/(?:^|\/)SKILL\.md$/, "");
    }
  }
  ref = input.ref ?? ref;
  path = input.path ?? path;
  if (
    !ref ||
    ref.length > 240 ||
    /[\s\\?#]/.test(ref) ||
    [...ref].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    ref.split("/").some((p) => !p || p === "." || p === "..") ||
    !pathOK(path)
  )
    throw invalid("分支或 Skill 目录无效；含 / 的分支请通过单独的分支字段指定");
  const source = {
    kind,
    url:
      kind === "skills-sh"
        ? `https://skills.sh/${repository}/${selector}`
        : `https://${host}/${repository}`,
    repository,
    ref,
    commit: "",
    path,
  } satisfies SkillRemoteSource;
  return { source, selector };
}

/** Only provider-owned HTTPS endpoints are constructed here. No shell, Git hooks, credentials or package scripts are invoked. */
export class SkillSources {
  private active = 0;
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  private async response(url: string, limit: number, signal: AbortSignal) {
    const response = await this.fetcher(url, {
      signal,
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "Agent-Platform-Skill-Import" },
    });
    if (response.status === 429 || response.status === 403) {
      await response.body?.cancel();
      throw unavailable("来源平台限流或拒绝匿名读取，请稍后重试，也可下载 Skill 后上传 ZIP");
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw invalid("仓库、分支或文件不存在，或来源需要私有凭据");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable(`来源读取失败（HTTP ${response.status}），请检查原始仓库链接`);
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw invalid("来源内容超过读取上限");
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable("来源未返回内容");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > limit) throw invalid("来源内容超过读取上限");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  }
  private async json(url: string, signal: AbortSignal) {
    const response = await this.response(url, 8 * 1024 * 1024, signal);
    return { value: JSON.parse(response.bytes.toString("utf8")), headers: response.headers };
  }
  private root(source: SkillRemoteSource) {
    return source.kind === "gitlab"
      ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(source.repository)}/repository`
      : `https://api.github.com/repos/${source.repository}`;
  }
  private async tree(source: SkillRemoteSource, signal: AbortSignal): Promise<Entry[]> {
    const root = this.root(source);
    if (source.kind !== "gitlab") {
      const { value } = await this.json(`${root}/git/trees/${source.commit}?recursive=1`, signal);
      const result = z
        .object({ truncated: z.boolean(), tree: z.array(entrySchema).max(20000) })
        .parse(value);
      if (result.truncated)
        throw invalid("仓库目录结果被上游截断，请将 Skill 放入较小的仓库或上传 ZIP");
      return result.tree;
    }
    const entries: Entry[] = [];
    for (let page = 1; page <= 50; page++) {
      const { value, headers } = await this.json(
        `${root}/tree?ref=${source.commit}&recursive=true&per_page=100&page=${page}${source.path ? `&path=${encodeURIComponent(source.path)}` : ""}`,
        signal,
      );
      const current = z.array(entrySchema).parse(value);
      entries.push(...current);
      if (!headers.get("x-next-page") && current.length < 100) return entries;
      if (headers.has("x-next-page") && !headers.get("x-next-page")) return entries;
    }
    throw invalid("仓库目录超过 5000 项，请指定 Skill 子目录后重试");
  }
  private async file(source: SkillRemoteSource, entry: Entry, signal: AbortSignal) {
    if (
      !["100644", "100755"].includes(entry.mode) ||
      entry.type !== "blob" ||
      !SkillPath.safeParse(entry.path).success
    )
      throw invalid(`不支持链接、子模块或特殊路径：${entry.path}`);
    if ((entry.size ?? 0) > 2 * 1024 * 1024) throw invalid(`文件超过 2 MiB：${entry.path}`);
    const url =
      source.kind === "gitlab"
        ? `${this.root(source)}/blobs/${entry.id}/raw`
        : `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${encodePath(entry.path)}`;
    const { bytes } = await this.response(url, 2 * 1024 * 1024, signal);
    const expected = entry.sha ?? entry.id;
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (!expected || expected !== actual) throw invalid(`来源文件完整性校验失败：${entry.path}`);
    if (bytes.subarray(0, 80).toString().startsWith("version https://git-lfs.github.com/spec/v1"))
      throw invalid(`暂不支持 Git LFS 指针，请上传实际内容：${entry.path}`);
    return bytes;
  }
  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>) {
    if (this.active >= 4)
      throw new ApiError(429, "SKILL_SOURCE_BUSY", "当前正在处理其他来源请求，请稍后重试");
    this.active++;
    const controller = new AbortController();
    try {
      return await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable("来源读取超时、网络不可达或响应格式不兼容，请重试或上传 ZIP");
    } finally {
      controller.abort();
      this.active--;
    }
  }
  async discover(input: SkillSourceInput): Promise<SkillDiscovery> {
    return this.bounded(async (signal) => {
      const { source, selector } = parseSkillSource(input);
      const { value } = await this.json(
        `${this.root(source)}/commits/${encodeURIComponent(source.ref)}`,
        signal,
      );
      source.commit = hash.parse(source.kind === "gitlab" ? value.id : value.sha);
      const tree = await this.tree(source, signal);
      const candidates = tree.filter(
        (e) =>
          e.type === "blob" &&
          (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md")) &&
          (!source.path || e.path.startsWith(`${source.path}/`)),
      );
      if (candidates.length > 100) throw invalid("找到超过 100 个 Skill，请指定子目录缩小范围");
      const found: SkillDiscovery["candidates"] = [];
      for (let i = 0; i < candidates.length; i += 4) {
        const batch = await Promise.all(
          candidates.slice(i, i + 4).map(async (entry) => {
            const path = entry.path === "SKILL.md" ? "" : entry.path.slice(0, -9);
            const bytes = await this.file(source, entry, signal);
            const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString("utf8"));
            let name = path.split("/").at(-1) || source.repository.split("/").at(-1) || "Skill";
            if (match) {
              const doc = parseDocument(match[1]);
              if (!doc.errors.length) {
                const declaredName = doc.get("name");
                if (typeof declaredName === "string") name = declaredName.slice(0, 128);
              }
            }
            return {
              path,
              name,
              fileCount: tree.filter(
                (e) => e.type !== "tree" && (!path || e.path.startsWith(`${path}/`)),
              ).length,
            };
          }),
        );
        found.push(...batch);
      }
      const selected = selector
        ? found.filter((c) => c.name === selector || c.path.split("/").at(-1) === selector)
        : found;
      if (!selected.length)
        throw invalid(
          selector
            ? `仓库中未找到 ${selector} 对应的 Skill，请使用仓库链接重新选择`
            : "所选目录下未找到 SKILL.md",
        );
      return { source, candidates: selected.sort((a, b) => a.path.localeCompare(b.path)) };
    });
  }
  async read(input: SkillSourceInput, commit: string, path: string) {
    return this.bounded(async (signal) => {
      const { source, selector } = parseSkillSource(input);
      source.commit = hash.parse(commit);
      if (
        !pathOK(path) ||
        (source.path && path !== source.path && !path.startsWith(`${source.path}/`))
      )
        throw invalid("所选 Skill 不在来源目录中");
      source.path = path;
      const tree = await this.tree(source, signal);
      const entries = tree.filter(
        (e) => e.type !== "tree" && (!path || e.path.startsWith(`${path}/`)),
      );
      if (!entries.some((e) => e.path === (path ? `${path}/SKILL.md` : "SKILL.md")))
        throw invalid("所选目录缺少 SKILL.md");
      if (entries.length > 200 || entries.reduce((n, e) => n + (e.size ?? 0), 0) > 16 * 1024 * 1024)
        throw invalid("Skill 超过 200 个文件或 16 MiB，请拆分后导入");
      const zip = new JSZip();
      let total = 0;
      for (let i = 0; i < entries.length; i += 4) {
        const batch = await Promise.all(
          entries
            .slice(i, i + 4)
            .map(async (entry) => ({ entry, bytes: await this.file(source, entry, signal) })),
        );
        for (const { entry, bytes } of batch) {
          total += bytes.length;
          if (total > 16 * 1024 * 1024) throw invalid("Skill 内容超过 16 MiB");
          zip.file(path ? entry.path.slice(path.length + 1) : entry.path, bytes, {
            createFolders: false,
            date: new Date("1980-01-01T00:00:00Z"),
          });
        }
      }
      const pkg = await importSkillArchive(
        await zip.generateAsync({ type: "base64", compression: "DEFLATE" }),
      );
      if (selector && selector !== pkg.manifest.name && selector !== path.split("/").at(-1))
        throw invalid("所选内容与 skills.sh 链接中的 Skill 不一致，请重新选择来源");
      return { pkg, source };
    });
  }
}
