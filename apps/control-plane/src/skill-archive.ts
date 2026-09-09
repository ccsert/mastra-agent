import { createHash } from "node:crypto";
import { SkillManifest, SkillPath, z } from "@platform/contracts";
import { parseDocument } from "yaml";
import { fromBuffer, type ZipFile } from "yauzl";
import { ApiError } from "./errors.ts";

const MAX_ARCHIVE = 4 * 1024 * 1024,
  MAX_EXPANDED = 16 * 1024 * 1024,
  MAX_FILE = 2 * 1024 * 1024;
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const invalid = (message: string) => new ApiError(400, "SKILL_PACKAGE_INVALID", message);
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const name = z
  .string()
  .min(1)
  .refine(
    (value) =>
      [...value].length <= 64 &&
      /^[\p{L}\p{N}-]+$/u.test(value) &&
      value === value.toLowerCase() &&
      !value.startsWith("-") &&
      !value.endsWith("-") &&
      !value.includes("--"),
  );
const frontmatter = z
  .object({
    name,
    description: z
      .string()
      .min(1)
      .refine((s) => !!s.trim() && [...s].length <= 1024),
    license: z.string().optional(),
    compatibility: z
      .string()
      .min(1)
      .refine((s) => [...s].length <= 500)
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .strict();

/** ZIP decoding is bounded before and during inflation; no archive path ever reaches the host filesystem. */
async function unzip(archive: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error || !zip ? reject(error) : resolve(zip)),
    ),
  );
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>(),
      paths = new Set<string>(),
      portablePaths = new Map<string, string>();
    let expanded = 0,
      count = 0,
      failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (!failed) resolve(files);
    });
    zip.on("entry", (entry) => {
      if (failed) return;
      try {
        const directory = entry.fileName.endsWith("/"),
          path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          ++count > 240 ||
          !SkillPath.safeParse(path).success ||
          paths.has(path) ||
          (mode && mode !== (directory ? 0o040000 : 0o100000)) ||
          entry.isEncrypted()
        )
          throw invalid("ZIP 包含重复路径、越界路径、链接、特殊文件或加密条目");
        const segments = path.split("/");
        for (let i = 1; i <= segments.length; i++) {
          const prefix = segments.slice(0, i).join("/"),
            key = prefix.normalize("NFC").toLowerCase();
          const existing = portablePaths.get(key);
          if (existing && existing !== prefix)
            throw invalid("平台限制：路径不能仅有大小写或 Unicode 规范化差异");
          portablePaths.set(key, prefix);
        }
        paths.add(path);
        if (directory) {
          zip.readEntry();
          return;
        }
        if (
          files.size >= 200 ||
          entry.uncompressedSize > MAX_FILE ||
          expanded + entry.uncompressedSize > MAX_EXPANDED
        )
          throw invalid("平台限制：最多 200 个文件，单文件 2 MiB，展开总量 16 MiB");
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            expanded += chunk.length;
            if (size > MAX_FILE || expanded > MAX_EXPANDED) {
              stream.destroy();
              fail(invalid("展开内容超过平台限制"));
            } else chunks.push(chunk);
          });
          stream.on("end", () => {
            if (failed) return;
            files.set(path, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}
export async function importSkillArchive(base64: string) {
  try {
    const archive = Buffer.from(base64, "base64");
    if (!archive.length || archive.length > MAX_ARCHIVE || archive.toString("base64") !== base64)
      throw invalid("请上传不超过 4 MiB 的 ZIP 文件");
    const raw = await unzip(archive);
    const prefix = raw.has("SKILL.md")
      ? ""
      : (() => {
          const roots = [...raw.keys()].filter((p) => /^[^/]+\/SKILL\.md$/.test(p));
          if (roots.length !== 1) throw invalid("ZIP 必须包含一个 Skill，根目录需要 SKILL.md");
          return roots[0].slice(0, -"SKILL.md".length);
        })();
    if ([...raw.keys()].some((p) => !p.startsWith(prefix)))
      throw invalid("ZIP 外层目录只能包含一个 Skill");
    const files = new Map([...raw].map(([path, content]) => [path.slice(prefix.length), content]));
    for (const path of files.keys()) {
      if (
        !SkillPath.safeParse(path).success ||
        path
          .split("/")
          .slice(0, -1)
          .some((_, i, parts) => files.has(parts.slice(0, i + 1).join("/")))
      )
        throw invalid("ZIP 文件与目录路径冲突");
    }
    const document = files.get("SKILL.md");
    if (!document) throw invalid("缺少 SKILL.md");
    const markdown = text(document),
      match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match) throw invalid("SKILL.md 必须以 YAML frontmatter 开始");
    const yaml = parseDocument(match[1], { uniqueKeys: true });
    if (yaml.errors.length || yaml.warnings.length) throw invalid("SKILL.md 的 YAML 字段无法解析");
    const parsed = frontmatter.safeParse(yaml.toJS({ maxAliasCount: 0 }));
    if (!parsed.success)
      throw invalid(
        "Skill 标准字段不合法：" +
          parsed.error.issues.map((i) => i.path.join(".") || "frontmatter").join("、"),
      );
    const meta = parsed.data;
    if (prefix && prefix !== `${meta.name}/`) throw invalid("外层目录名必须与 Skill name 一致");
    const manifest = SkillManifest.parse({
      ...meta,
      allowedTools: meta["allowed-tools"],
      files: [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, bytes]) => {
          let encoding = "utf-8";
          try {
            text(bytes);
          } catch {
            encoding = "base64";
          }
          return { path, hash: sha256(bytes), size: bytes.length, encoding };
        }),
      entrypoints: [...files.keys()]
        .filter((p) => /^scripts\/.*\.(m?js|cjs|py|sh)$/.test(p))
        .sort(),
      warnings: [
        ...(markdown.split("\n").length > 500
          ? ["建议将超过 500 行的正文拆到 references/；本项不影响格式通过"]
          : []),
        ...(meta["allowed-tools"]
          ? ["allowed-tools 是包内声明，不会自动授予平台工具或脚本权限"]
          : []),
      ],
    });
    return {
      archive,
      archiveHash: sha256(archive),
      files,
      manifest,
      digest: sha256(JSON.stringify(manifest.files)),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid("ZIP 或 SKILL.md 无法安全解析，请检查文件格式与编码");
  }
}
