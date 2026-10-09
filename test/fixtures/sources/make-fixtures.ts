// Makes the source fixtures in this folder. All text is invented (the worked example's domain) — no client data.
// Run on macOS from the repo root: `bun run test/fixtures/sources/make-fixtures.ts`
//   rooms.pdf   — `cupsfilter rooms.txt` (macOS CUPS text → PDF filter) from the text below
//   rooms.docx  — `textutil -convert docx` (macOS) from the same text
//   rooms.xlsx  — written by exceljs here: sheet "ห้อง", rows ห้อง|จุ · ห้องใหญ่|20 · ห้องเล็ก|6
//   notes.txt   — UTF-8 text written here
//   corrupt.pdf — "%PDF-1.4" followed by junk bytes: looks like a PDF, cannot be read
//   tiny.png    — a 1×1 transparent PNG (bytes below)
//   old.doc     — bytes that are no supported type (no magic number, name not .txt)
import ExcelJS from "exceljs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const RULE = "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ"; // TASK R4 searches for this line (AC-4)
const ROOMS_TEXT = `ระเบียบการจองห้องประชุม\n${RULE}\nห้องเล็กยืนยันได้ทันที\nRoom booking rules\n`;

function run(cmd: string[], stdoutTo?: string) {
  const r = Bun.spawnSync(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (exit ${r.exitCode})`);
  if (stdoutTo) writeFileSync(stdoutTo, r.stdout);
}

const work = mkdtempSync(join(tmpdir(), "blueprint-fixtures-"));
try {
  const txt = join(work, "rooms.txt");
  writeFileSync(txt, ROOMS_TEXT);
  run(["/usr/sbin/cupsfilter", txt], join(here, "rooms.pdf"));
  run(["/usr/bin/textutil", "-convert", "docx", txt, "-output", join(here, "rooms.docx")]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet("ห้อง");
sheet.addRow(["ห้อง", "จุ"]);
sheet.addRow(["ห้องใหญ่", 20]);
sheet.addRow(["ห้องเล็ก", 6]);
writeFileSync(join(here, "rooms.xlsx"), Buffer.from(await wb.xlsx.writeBuffer()));

writeFileSync(join(here, "notes.txt"), "บันทึกการประชุม: ผู้ดูแลห้องต้องตอบภายใน 24 ชั่วโมง\n");
writeFileSync(join(here, "corrupt.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("this is not a real pdf body \x00\x01\x02 ".repeat(20), "latin1")]));
writeFileSync(join(here, "tiny.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
writeFileSync(join(here, "old.doc"), Buffer.from("old word document? no — plain bytes with no known signature \x00\x00\x07", "latin1"));

console.log("fixtures written:", readFileSync(join(here, "rooms.pdf")).length, "B pdf");
