// TASK-A-016 REWORK round 1: SA-A's answers to Q1–Q5. No network: lookup and fetch are injected.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { projects } from "../../src/db/schema";
import { extract } from "../../src/sources/extract";
import { fetchLink, isPrivateAddress, type LinkDeps } from "../../src/sources/link";
import { AlreadyAdded, addFile, addLink, getSource } from "../../src/sources/service";
import { testDb } from "../helpers/db";

const origin = { stamp: "operator", date: "2026-10-09" };
const PUBLIC = "93.184.215.14";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "blueprint-sources-")); dirs.push(d); return d; };

function world(pages: Record<string, () => Response>): LinkDeps {
  return {
    lookup: async () => [{ address: PUBLIC, family: 4 }],
    fetch: async (url: string) => { const p = pages[url]; if (!p) throw new Error("connection refused"); return p(); },
  };
}

async function setup() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  return { db, pid: p!.id, dir: tempDir() };
}

test("Q1: re-adding a failed link re-fetches and updates that row", async () => {
  const { db, pid, dir } = await setup();
  let up = false;
  const deps = world({ "https://www.example.com/rules": () => up
    ? new Response("กฎการจอง", { headers: { "content-type": "text/plain; charset=utf-8" } })
    : new Response("down", { status: 503 }) });
  const first = await addLink(db, dir, pid, { link: "https://www.example.com/rules", origin }, deps);
  expect([first.status, first.reason]).toEqual(["failed", "link_unreachable"]);
  up = true;
  const again = await addLink(db, dir, pid, { link: "https://www.example.com/rules", origin }, deps);
  expect([again.id, again.status]).toEqual([first.id, "read"]);
  expect((await getSource(db, pid, first.id)).text).toBe("กฎการจอง");
  // A link that is read now is a plain duplicate.
  const third = await addLink(db, dir, pid, { link: "https://www.example.com/rules", origin }, deps).catch((e) => e);
  expect(third).toBeInstanceOf(AlreadyAdded);
  expect((third as AlreadyAdded).sourceId).toBe(first.id);
});

test("Q1: a re-fetched body that is already another source → 409 with that id; the failed row stays", async () => {
  const { db, pid, dir } = await setup();
  const file = await addFile(db, dir, pid, { name: "notes.txt", bytes: new TextEncoder().encode("same body"), origin });
  let up = false;
  const deps = world({ "https://www.example.com/same": () => up
    ? new Response("same body", { headers: { "content-type": "text/plain" } })
    : new Response("down", { status: 503 }) });
  const failed = await addLink(db, dir, pid, { link: "https://www.example.com/same", origin }, deps);
  up = true;
  const err = await addLink(db, dir, pid, { link: "https://www.example.com/same", origin }, deps).catch((e) => e);
  expect(err).toBeInstanceOf(AlreadyAdded);
  expect((err as AlreadyAdded).sourceId).toBe(file.id);
  const still = await getSource(db, pid, failed.id);
  expect([still.status, still.reason, still.sha256]).toEqual(["failed", "link_unreachable", failed.sha256]);
});

// The rooms.docx fixture with its central directory patched to claim word/document.xml unpacks to `bytes`
// (nothing large is made; the zip's real content is unchanged).
function docxDeclaring(bytes: number): Uint8Array {
  const zip = new Uint8Array(readFileSync(new URL("../fixtures/sources/rooms.docx", import.meta.url).pathname));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const name = new TextEncoder().encode("word/document.xml");
  let patched = 0;
  for (let i = 0; i + 46 < zip.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    if (len === name.length && name.every((b, k) => zip[i + 46 + k] === b)) { view.setUint32(i + 24, bytes, true); patched++; }
  }
  if (patched !== 1) throw new Error(`expected one word/document.xml entry, patched ${patched}`);
  return zip;
}

test("Q2: a docx declaring more than 100 MB unpacked is text_too_large before it is opened", async () => {
  const r = await extract(docxDeclaring(200_000_000), "big.docx");
  expect(r.status === "failed" && r.reason).toBe("text_too_large");
  // Control: the same file with its true sizes is read.
  const ok = await extract(new Uint8Array(readFileSync(new URL("../fixtures/sources/rooms.docx", import.meta.url).pathname)), "rooms.docx");
  expect(ok.status === "read" && ok.text).toContain("ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ");
});

test("Q2: more than 2,000,000 characters of text is text_too_large and no text is stored", async () => {
  const { db, pid, dir } = await setup();
  const s = await addFile(db, dir, pid, { name: "long.txt", bytes: new TextEncoder().encode("ก".repeat(2_000_001)), origin });
  expect([s.status, s.reason]).toEqual(["failed", "text_too_large"]);
  expect((await getSource(db, pid, s.id)).text).toBe("");
  const edge = await addFile(db, dir, pid, { name: "edge.txt", bytes: new TextEncoder().encode("a".repeat(2_000_000)), origin });
  expect(edge.status).toBe("read");
});

test("Q3: multicast, reserved, broadcast, benchmark and site-local addresses are refused", () => {
  for (const a of ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "198.18.0.1", "198.19.255.255",
    "fec0::1", "ff02::1", "ff05::2"]) {
    expect([a, isPrivateAddress(a)]).toEqual([a, true]);
  }
  for (const a of ["198.17.255.255", "198.20.0.1", "223.255.255.255"]) expect([a, isPrivateAddress(a)]).toEqual([a, false]);
});

test("Q4: an unknown charset label is read as UTF-8 with note charset_unknown", async () => {
  const r = await fetchLink("https://www.example.com/c", world({
    "https://www.example.com/c": () => new Response("สวัสดี", { headers: { "content-type": "text/plain; charset=x-made-up" } }),
  }));
  expect(r.kind === "fetched" && r.outcome).toEqual({ status: "read", text: "สวัสดี", note: "charset_unknown" });
});

test("Q5: a broken multipart body is 400 validation without a JSON hint", async () => {
  process.env.SOURCES_DIR = tempDir();
  const app = createApp(await testDb());
  const pid = (await (await app.request("/v1/projects", {
    method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" },
  })).json() as any).id;
  const res = await app.request(`/v1/projects/${pid}/sources`, {
    method: "POST", body: "this is not multipart", headers: { "content-type": "multipart/form-data; boundary=zzz" },
  });
  const body = await res.json() as any;
  expect([res.status, body.error.code]).toEqual([400, "validation"]);
  expect(body.error.message).not.toContain("application/json");
  const bad = await app.request("/v1/projects", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
  expect(((await bad.json()) as any).error.message).toContain("application/json");
});
