import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocument } from "../../apps/control-plane/src/modules/knowledge/parser.ts";
import { docxFixture, pdfFixture } from "../fixtures/knowledge-documents.ts";
import { skillZip } from "../fixtures/skill-fixture.ts";

test("document parsing preserves PDF pages and DOCX paragraphs with immutable byte hashes", async () => {
  const pdf = await parseDocument(
    "guide.pdf",
    pdfFixture(["A5000 has 24GB memory.", "", "Warranty is three years."]),
    800,
    80,
  );
  assert.equal(pdf.sections.length, 3);
  assert.equal(pdf.chunks[1].location.index, 3);
  assert.match(pdf.warnings.join(" "), /1 页/);
  const word = await parseDocument(
    "规则.docx",
    docxFixture(["A5000 有 24GB 显存。", "保修三年。"]),
    800,
    80,
  );
  assert.equal(word.sections[1].content, "保修三年。");
  assert.equal(word.sections[1].location.index, 2);
  assert.equal(word.chunks[0].location.endIndex, 2);
  const md = await parseDocument(
    "guide.md",
    Buffer.from("# A5000\n\n24GB 显存。\n\n## 保修\n\n保修三年。"),
    800,
    80,
  );
  assert.ok(md.chunks.some((c) => c.content.includes("## 保修")));
  assert.equal(md.chunks.length, 1, "short headed sections must retain document context");
  assert.equal(md.chunks[0].location.endIndex, 4);
  assert.ok(md.chunks.every((c) => c.content.length <= 800));
  assert.equal(
    (await parseDocument("copy.docx", docxFixture(["A5000 有 24GB 显存。", "保修三年。"]), 800, 80))
      .contentHash,
    word.contentHash,
  );
});
test("unreadable, oversized and unsafe documents are rejected without empty searchable content", async () => {
  await assert.rejects(parseDocument("scan.pdf", pdfFixture([""]), 800, 80), {
    code: "OCR_REQUIRED",
  });
  await assert.rejects(parseDocument("bad.pdf", Buffer.from("not a pdf"), 800, 80), {
    code: "INVALID_DOCUMENT",
  });
  await assert.rejects(parseDocument("invalid.txt", Buffer.from([0xff, 0xfe, 0xfd]), 800, 80), {
    code: "PARSE_FAILED",
  });
  await assert.rejects(parseDocument("huge.txt", Buffer.from("x".repeat(200001)), 800, 80), {
    code: "DOCUMENT_TOO_LARGE",
  });
  await assert.rejects(parseDocument("empty.txt", Buffer.from("   "), 800, 80), {
    code: "EMPTY_DOCUMENT",
  });
  await assert.rejects(
    parseDocument(
      "unsafe.docx",
      Buffer.from(
        skillZip([
          { path: "word/document.xml", content: "x" },
          { path: "../escape", content: "x" },
        ]),
        "base64",
      ),
      800,
      80,
    ),
    { code: "PARSE_FAILED" },
  );
});
