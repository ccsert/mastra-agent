import { createHash } from "node:crypto";
import { MDocument } from "@mastra/rag";
import type { DocumentSection, PlannedChunk, z } from "@platform/contracts";
import mammoth from "mammoth";
import * as yauzl from "yauzl";

type Section = z.infer<typeof DocumentSection>;
class ParseFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new ParseFailure(code, message);
}
async function checkDocx(bytes: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("Invalid ZIP"));
      let count = 0,
        total = 0,
        hasDocument = false;
      const names = new Set<string>();
      const stop = (error: Error) => {
        zip.close();
        reject(error);
      };
      zip.on("error", stop);
      zip.on("entry", (entry: yauzl.Entry) => {
        count++;
        total += entry.uncompressedSize;
        const name = entry.fileName;
        if (
          count > 1000 ||
          total > 32 * 1024 * 1024 ||
          entry.uncompressedSize > 8 * 1024 * 1024 ||
          entry.generalPurposeBitFlag & 1 ||
          names.has(name) ||
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").includes("..") ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        )
          return stop(new Error("Unsafe ZIP"));
        names.add(name);
        if (name === "word/document.xml") hasDocument = true;
        if (name.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return stop(new Error("Invalid entry"));
          let actual = 0;
          stream.on("data", (data: Buffer) => {
            actual += data.length;
            if (actual > entry.uncompressedSize) {
              stream.destroy();
              stop(new Error("Invalid size"));
            }
          });
          stream.on("error", stop);
          stream.on("end", () => zip.readEntry());
        });
      });
      zip.on("end", () => (hasDocument ? resolve() : reject(new Error("Missing document"))));
      zip.readEntry();
    });
  });
}
async function parse(workerData: {
  filename: string;
  bytes: Uint8Array;
  chunkSize: number;
  chunkOverlap: number;
}) {
  const { filename, chunkSize, chunkOverlap } = workerData as {
    filename: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  const bytes = Buffer.from(workerData.bytes),
    format = filename.split(".").at(-1)?.toLowerCase();
  const sections: Section[] = [],
    warnings: string[] = [];
  if (format === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      fail("INVALID_DOCUMENT", "文件内容不是 PDF");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0,
    });
    try {
      const doc = await task.promise;
      if (doc.numPages > 200) fail("DOCUMENT_TOO_LARGE", "PDF 最多 200 页，请拆分后上传");
      let total = 0;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber),
          text = await page.getTextContent();
        const content = text.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join("")
          .trim();
        total += content.length;
        if (total > 200000) fail("DOCUMENT_TOO_LARGE", "解析正文超过 20 万字符");
        sections.push({ location: { kind: "page", index: pageNumber }, content });
        page.cleanup();
      }
      const empty = sections.filter((s) => !s.content).length;
      if (empty === sections.length)
        fail("OCR_REQUIRED", "PDF 没有可提取文字，可能是扫描件，需要先进行 OCR");
      if (empty) warnings.push(`${empty} 页没有可提取文字；图片中的内容尚未识别。`);
      warnings.push("按 PDF 文字层提取；多栏、表格和图片需核对解析顺序，暂不进行 OCR。");
    } catch (error) {
      if (error instanceof Error && error.name === "PasswordException")
        fail("PDF_PASSWORD", "PDF 已加密，请解密后上传");
      throw error;
    } finally {
      await task.destroy();
    }
  } else {
    let text: string;
    if (format === "docx") {
      await checkDocx(bytes);
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = result.value;
      warnings.push("DOCX 按提取后的段落定位；保留正文文字，暂不保留版式、图片和 Word 页码。");
      if (result.messages.length) warnings.push("解析器报告部分格式不支持，请核对正文预览。");
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (text.includes("\0")) fail("INVALID_DOCUMENT", "正文包含非法空字符");
    if (text.length > 200000) fail("DOCUMENT_TOO_LARGE", "解析正文超过 20 万字符");
    for (const content of text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean))
      sections.push({ location: { kind: "paragraph", index: sections.length + 1 }, content });
    if (!sections.length) fail("EMPTY_DOCUMENT", "文档没有可用正文");
    if (sections.length > 2000) fail("DOCUMENT_TOO_LARGE", "文档段落超过 2000 段，请拆分后上传");
  }
  // Preserve source locations while grouping short paragraphs; never merge PDF pages.
  const groups: Section[] = [];
  for (const section of sections.filter((s) => s.content)) {
    const last = groups.at(-1);
    if (format !== "pdf" && last && last.content.length + section.content.length + 2 <= chunkSize) {
      last.content += `\n\n${section.content}`;
      last.location.endIndex = section.location.index;
    } else groups.push({ content: section.content, location: { ...section.location } });
  }
  const chunks: z.infer<typeof PlannedChunk>[] = [];
  for (const group of groups) {
    const doc =
      format === "md" ? MDocument.fromMarkdown(group.content) : MDocument.fromText(group.content);
    const structured =
      format === "md"
        ? await doc.chunk({
            strategy: "markdown",
            headers: [
              ["#", "title"],
              ["##", "section"],
              ["###", "subsection"],
            ],
            stripHeaders: false,
          })
        : [{ text: group.content }];
    // Keep short headed sections together so boilerplate is not indexed in isolation.
    const packed: { text: string }[] = [];
    for (const part of structured) {
      const last = packed.at(-1);
      if (last && last.text.length + part.text.length + 2 <= chunkSize)
        last.text += `\n\n${part.text}`;
      else packed.push({ text: part.text });
    }
    const split = (
      await Promise.all(
        packed.map((part) =>
          MDocument.fromText(part.text).chunk({
            strategy: "recursive",
            maxSize: chunkSize,
            overlap: chunkOverlap,
            separators:
              format === "md"
                ? ["\n## ", "\n### ", "\n\n", "\n", "。", "；", " ", ""]
                : ["\n\n", "\n", "。", "；", " ", ""],
          }),
        ),
      )
    ).flat();
    for (const chunk of split)
      chunks.push({ ordinal: chunks.length, content: chunk.text, location: group.location });
    if (chunks.length > 256)
      fail("DOCUMENT_TOO_LARGE", "分段超过 256 段，请拆分文档或调整分段大小");
  }
  return {
    filename,
    format,
    byteSize: bytes.length,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    sections,
    chunks,
    warnings,
  };
}
process.once("message", async (input) => {
  try {
    process.send?.(
      await parse(
        input as { filename: string; bytes: Uint8Array; chunkSize: number; chunkOverlap: number },
      ),
    );
  } catch (error) {
    process.send?.({
      error: error instanceof ParseFailure ? error.code : "PARSE_FAILED",
      message:
        error instanceof ParseFailure
          ? error.message
          : "无法解析文件，请检查文件是否损坏、编码或格式是否正确",
    });
  }
});
