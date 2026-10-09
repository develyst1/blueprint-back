// Text out of an original (SPEC-A-003 § Extraction). The kind comes from the bytes, never from the name —
// except plain text, which has no magic number: then the name must end .txt and the bytes must be valid UTF-8.
import ExcelJS from "exceljs";
import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export type Extracted =
  | { status: "read"; mime: string; text: string; note?: "no_text_in_image" }
  | { status: "failed"; mime: string; reason: "unreadable_pdf" | "unreadable_docx" | "unreadable_xlsx" | "extract_error" | "text_too_large" }
  | { status: "unsupported" };

// Decompression-bomb limits (SA-A, TASK-A-016 Q2, `Interpreted`, reversible): past any of them → `text_too_large`.
export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_ZIP_UNPACKED_BYTES = 100_000_000;
export const MAX_PDF_PAGES = 2_000;

export const tooLong = (text: string) => text.length > MAX_TEXT_CHARS;

// Total uncompressed size the zip's central directory declares, read without unpacking anything.
// null = no readable central directory (the library will then call it unreadable); ZIP64 markers count as too big.
export function zipDeclaredSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return Infinity;
    total += size;
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries === 0xffff ? Infinity : total;
}

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT = "text/plain";

export async function sniff(bytes: Uint8Array, nameHint: string): Promise<string | null> {
  const mime = (await fileTypeFromBuffer(bytes))?.mime;
  if (mime === undefined) {
    if (!nameHint.toLowerCase().endsWith(".txt")) return null;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return TEXT; } catch { return null; }
  }
  return mime === PDF || mime === DOCX || mime === XLSX || IMAGES.has(mime) ? mime : null;
}

export class TooLarge extends Error {}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  // unpdf may detach the buffer it is given: hand it a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  if (doc.numPages > MAX_PDF_PAGES) throw new TooLarge();
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; text?: unknown; result?: unknown; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
    if (o.hyperlink) return o.hyperlink;
    return "";
  }
  return String(v);
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheets: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [`# ${sheet.name}`];
    // Row values are 1-based: index 0 is always empty.
    sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(cellText).join("\t")));
    sheets.push(rows.join("\n"));
  });
  return sheets.join("\n\n");
}

export async function extract(bytes: Uint8Array, nameHint: string): Promise<Extracted> {
  const mime = await sniff(bytes, nameHint);
  if (mime === null) return { status: "unsupported" };
  if (IMAGES.has(mime)) return { status: "read", mime, text: "", note: "no_text_in_image" };
  if (mime === TEXT) {
    const text = new TextDecoder("utf-8").decode(bytes);
    return tooLong(text) ? { status: "failed", mime, reason: "text_too_large" } : { status: "read", mime, text };
  }
  if (mime === DOCX || mime === XLSX) {
    const declared = zipDeclaredSize(bytes);
    if (declared !== null && declared > MAX_ZIP_UNPACKED_BYTES) return { status: "failed", mime, reason: "text_too_large" };
  }
  const reason = mime === PDF ? "unreadable_pdf" : mime === DOCX ? "unreadable_docx" : "unreadable_xlsx";
  let run: () => Promise<string>;
  if (mime === PDF) run = () => pdfText(bytes);
  else if (mime === DOCX) run = async () => (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  else run = () => xlsxText(bytes);
  try {
    const text = await run();
    return tooLong(text) ? { status: "failed", mime, reason: "text_too_large" } : { status: "read", mime, text };
  } catch (e) {
    if (e instanceof TooLarge) return { status: "failed", mime, reason: "text_too_large" };
    // The file is broken (the library says so) → that kind's "unreadable"; anything else → extract_error. Never a 500.
    return { status: "failed", mime, reason: isUnreadable(mime, e) ? reason : "extract_error" };
  }
}

// What each library throws for a broken file. Probed 2026-10-09: pdf.js `InvalidPDFException`; a truncated docx and
// xlsx both give JSZip's "Corrupted zip: can't find end of central directory". The other patterns are not probed.
function isUnreadable(mime: string, e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  if (mime === PDF) return ["InvalidPDFException", "FormatError", "MissingPDFException"].includes(err?.name ?? "");
  return /corrupted zip|end of central directory|could not find|not a valid|unsupported zip/i.test(err?.message ?? "");
}
