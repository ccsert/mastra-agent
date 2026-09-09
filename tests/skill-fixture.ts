import { crc32, deflateRawSync } from "node:zlib";
export const skillDoc = (marker = "ONE") =>
  `---\nname: report-skill\ndescription: 汇总订单输入，生成合成验收报表。\nmetadata:\n  author: platform-test\n---\n# 报表 Skill ${marker}\n先读 references/rules.md，再用 run_skill_script 调用 scripts/report.mjs。输入为 {"values":[40,80]}。结果来自 stdout。\n`;
export const reportScript = `let text=''; for await (const chunk of process.stdin) text+=chunk; const {values}=JSON.parse(text); console.log(JSON.stringify({total:values.reduce((a,b)=>a+b,0),marker:'ONE'}));`;
export function skillZip(entries: { path: string; content: string | Buffer; mode?: number }[]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      raw = Buffer.from(entry.content),
      compressed = deflateRawSync(raw),
      crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString("base64");
}
export const standardSkill = (marker = "ONE") =>
  skillZip([
    { path: "report-skill/SKILL.md", content: skillDoc(marker) },
    { path: "report-skill/scripts/report.mjs", content: reportScript.replace("ONE", marker) },
    { path: "report-skill/references/rules.md", content: "金额使用输入值求和，不得编造结果。" },
  ]);
