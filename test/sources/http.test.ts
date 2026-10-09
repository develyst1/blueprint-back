// Sources over HTTP: upload, extraction, duplicates, limits. Originals go to a temp SOURCES_DIR per test.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import { testDb } from "../helpers/db";

const FIX = new URL("../fixtures/sources/", import.meta.url).pathname;
const RULE = "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ";
const origin = { stamp: "operator", date: "2026-10-09" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function api() {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-sources-"));
  dirs.push(dir);
  process.env.SOURCES_DIR = dir;
  const app = createApp(await testDb());
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
  const project = async () => (await json(await app.request("/v1/projects", {
    method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" },
  }))).body.id as string;
  const upload = (pid: string, name: string, bytes: Uint8Array = readFileSync(join(FIX, name))) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name));
    form.append("origin", JSON.stringify(origin));
    return Promise.resolve(app.request(`/v1/projects/${pid}/sources`, { method: "POST", body: form })).then(json);
  };
  const get = (path: string) => Promise.resolve(app.request(path)).then(json);
  // Every stored original, excluding nothing: the whole tree under the temp dir.
  const filesOnDisk = () => readdirSync(dir, { recursive: true }).map(String).filter((p) => statSync(join(dir, p)).isFile());
  return { app, json, project, upload, get, filesOnDisk };
}

test("AC-1: a PDF and a DOCX are read; the text holds the rule; GET returns it", async () => {
  const { project, upload, get } = await api();
  const pid = await project();
  for (const name of ["rooms.pdf", "rooms.docx"]) {
    const r = await upload(pid, name);
    expect([name, r.status, r.body.status]).toEqual([name, 201, "read"]);
    expect(r.body.origin).toEqual(origin);
    expect(r.body.name).toBe(name);
    const one = await get(`/v1/projects/${pid}/sources/${r.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body.text).toContain(RULE);
  }
});

test("an XLSX is read as headed, tab-joined rows; a .txt is read", async () => {
  const { project, upload, get } = await api();
  const pid = await project();
  const x = await upload(pid, "rooms.xlsx");
  expect([x.status, x.body.status]).toEqual([201, "read"]);
  expect((await get(`/v1/projects/${pid}/sources/${x.body.id}`)).body.text).toBe("# ห้อง\nห้อง\tจุ\nห้องใหญ่\t20\nห้องเล็ก\t6");
  const t = await upload(pid, "notes.txt");
  expect([t.status, t.body.status]).toEqual([201, "read"]);
});

test("AC-2: a corrupt PDF is a failed source with its reason", async () => {
  const { project, upload } = await api();
  const r = await upload(await project(), "corrupt.pdf");
  expect([r.status, r.body.status, r.body.reason]).toEqual([201, "failed", "unreadable_pdf"]);
});

test("an image is read with no text; an unsupported file is 415 and leaves no row", async () => {
  const { project, upload, get } = await api();
  const pid = await project();
  const png = await upload(pid, "tiny.png");
  expect([png.status, png.body.status, png.body.note, png.body.mime]).toEqual([201, "read", "no_text_in_image", "image/png"]);
  const doc = await upload(pid, "old.doc");
  expect([doc.status, doc.body.error.code]).toEqual([415, "unsupported_file"]);
  expect((await get(`/v1/projects/${pid}/sources`)).body.map((s: any) => s.name)).toEqual(["tiny.png"]);
});

test("AC-3: the same file twice is 409 with the first id; one copy on disk across projects", async () => {
  const { project, upload, filesOnDisk } = await api();
  const a = await project();
  const first = await upload(a, "rooms.pdf");
  const again = await upload(a, "rooms.pdf");
  expect([again.status, again.body.error.code, again.body.error.details.sourceId]).toEqual([409, "already_added", first.body.id]);
  expect(filesOnDisk()).toEqual([`${first.body.sha256.slice(0, 2)}/${first.body.sha256}`]);
  const other = await upload(await project(), "rooms.pdf");
  expect(other.status).toBe(201);
  expect(filesOnDisk()).toHaveLength(1);
});

test("links over HTTP: a non-http scheme is 400 link_refused and leaves no row", async () => {
  const { app, json, project, get } = await api();
  const pid = await project();
  const r = await json(await app.request(`/v1/projects/${pid}/sources`, {
    method: "POST", body: JSON.stringify({ link: "ftp://files.example.com/a.pdf", origin }),
    headers: { "content-type": "application/json" },
  }));
  expect([r.status, r.body.error.code]).toEqual([400, "link_refused"]);
  expect((await get(`/v1/projects/${pid}/sources`)).body).toEqual([]);
});

test("limits: 8 MB to sources is not 413; 21 MB is 413 too_large; 6 MB elsewhere is still 413", async () => {
  const { app, json, project, upload } = await api();
  const pid = await project();
  const eight = await upload(pid, "big.bin", new Uint8Array(8_000_000).fill(7));
  expect(eight.status).toBe(415);
  const twentyOne = await upload(pid, "huge.bin", new Uint8Array(21_000_000).fill(7));
  expect([twentyOne.status, twentyOne.body.error.code]).toEqual([413, "too_large"]);
  const elsewhere = await json(await app.request("/v1/projects", {
    method: "POST", body: JSON.stringify({ name: "x".repeat(6_000_000) }), headers: { "content-type": "application/json" },
  }));
  expect([elsewhere.status, elsewhere.body.error.code]).toEqual([413, "too_large"]);
});

test("the list shows every source without its text; a source's own origin cannot point at a source", async () => {
  const { app, json, project, upload, get } = await api();
  const pid = await project();
  await upload(pid, "rooms.pdf");
  await upload(pid, "notes.txt");
  const list = await get(`/v1/projects/${pid}/sources`);
  expect(list.status).toBe(200);
  expect(list.body.map((s: any) => s.name).sort()).toEqual(["notes.txt", "rooms.pdf"]);
  expect(list.body.every((s: any) => !("text" in s))).toBe(true);
  const form = new FormData();
  form.append("file", new File([readFileSync(join(FIX, "tiny.png"))], "tiny.png"));
  form.append("origin", JSON.stringify({ ...origin, sourceId: "3f2b8c1e-9a4d-4c2e-8b1f-6d7e5a4c3b2a" }));
  const bad = await json(await app.request(`/v1/projects/${pid}/sources`, { method: "POST", body: form }));
  expect([bad.status, bad.body.error.code]).toEqual([400, "validation"]);
  expect((await get(`/v1/projects/00000000-0000-0000-0000-000000000099/sources`)).status).toBe(404);
});
