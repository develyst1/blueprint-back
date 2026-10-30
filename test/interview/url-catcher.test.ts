// REQ-114 round 2 / SPEC-111 E14 (TASK-136): every http(s) address the user wrote that no non-question part holds is stored by the
// server as an `api` part (`server:url <n>`) and recorded as `url_kept`, whatever the model did. Stub gateway only — no live call.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { messages, projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-30";
const MESSAGE = (await Bun.file(new URL("../fixtures/url-catcher-message.txt", import.meta.url)).text()).trim();
const ROUND1 = await Bun.file(new URL("../fixtures/url-catcher-round1.json", import.meta.url)).text();
const NOTHING = JSON.stringify({ reply: "ตามนั้นครับ", changes: [], questions: [], contradictions: [], suggestions: [] });

function stub(contents: (string | Error)[]) {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => {
      const next = contents[Math.min(calls.n++, contents.length - 1)]!;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: next, usage: {}, latency_ms: 1 } }));
    },
  });
  return { gateway, calls };
}
const timeoutGateway = () => {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com", timeoutMs: 60, firstAnswerTimeoutMs: 60,
    fetch: () => { calls.n++; return new Promise<Response>(() => {}); },
  });
  return { gateway, calls };
};
const reply = (changes: unknown[], questions: unknown[] = []) => JSON.stringify({ reply: "บันทึกแล้ว", changes, questions, contradictions: [], suggestions: [] });
const add = (ref: string, kind: string, title: string, body: unknown) => ({ change: { op: "part.add", ref, kind, title, body }, saidBy: "inferred", sure: true });

async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  return { db, pid: p!.id };
}
const apis = async (db: Db, pid: string) =>
  (await loadSpec(db, pid)).parts.filter((p) => p.kind === "api").map((p) => ({ key: p.key, path: (p.body as { path: string }).path, title: p.title, origin: p.origin.stamp }));
const rowOf = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
type Adj = { item: string; what: string; title: string | null; key: string | null; ref: string | null };

test("AC-4 replay (rebuilt TEST-111): 4 addresses in stored non-question parts, :3900 not duplicated, one url_kept each, round 2 adds none", async () => {
  const { db, pid } = await project();
  const { gateway, calls } = stub([ROUND1, NOTHING]);
  const r1 = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([r1.status, r1.refused, calls.n]).toEqual(["applied", null, 1]);
  const spec = await loadSpec(db, pid);
  expect(spec.parts.filter((p) => p.kind === "question")).toHaveLength(2); // the offered questions are still there
  const held = (url: string) => spec.parts.filter((p) => p.kind !== "question" && `${p.title} ${JSON.stringify(p.body)}`.includes(url)).map((p) => p.key);
  expect(held("http://127.0.0.1:3900")).toEqual(["WRK-001"]); // the app's own address: held by the model's part, so no server item
  const stored = await apis(db, pid);
  expect(stored.map((a) => a.path)).toEqual([
    "http://127.0.0.1:4200/health", "http://127.0.0.1:3100", "http://127.0.0.1:4500/health", "http://127.0.0.1:3500",
  ]);
  expect(stored.every((a) => a.origin === "team-proposed" && a.title === a.path)).toBe(true);
  for (const a of stored) expect(held(a.path)).toEqual([a.key]);
  const adjusted = r1.adjusted as Adj[];
  expect(adjusted.filter((a) => a.what === "url_kept").map((a) => [a.item, a.title, a.key, a.ref])).toEqual(
    stored.map((a, i) => [`server:url ${i + 1}`, a.path, a.key, `$url_${i + 1}`]));
  expect(adjusted).toHaveLength(4);
  expect((await rowOf(db, r1.messageIds[1]!)).roundAdjusted).toEqual(r1.adjusted);

  // round 2: the user accepts what was offered; the model has nothing to add
  const r2 = await runRound(db, gateway, pid, { accept: ["Q-001", "Q-002"] }, { today: TODAY });
  expect(r2.status).toBe("applied");
  expect(await apis(db, pid)).toEqual(stored);
  expect(r2.adjusted).toBeNull();
});

test("a model that times out on a message with 1 address: the address is stored, the status stays bot_could_not_answer, url_kept is recorded", async () => {
  const { db, pid } = await project();
  const { gateway, calls } = timeoutGateway();
  const round = await runRound(db, gateway, pid, { message: "ตรวจ http://127.0.0.1:4200/health ให้หน่อย" }, { today: TODAY });
  expect([round.status, round.reason, calls.n]).toEqual(["bot_could_not_answer", "timeout", 1]);
  const stored = await apis(db, pid);
  expect(stored).toEqual([{ key: "API-001", path: "http://127.0.0.1:4200/health", title: "http://127.0.0.1:4200/health", origin: "team-proposed" }]);
  expect(round.changeSetId).toEqual(expect.any(String));
  expect(round.adjusted).toEqual([{ item: "server:url 1", what: "url_kept", title: "http://127.0.0.1:4200/health", key: "API-001", ref: "$url_1" }]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ roundStatus: "bot_could_not_answer", roundReason: "timeout", changeSetId: round.changeSetId });
});

test("ลองใหม่ on that round: the address is held, so no second part for it", async () => {
  const { db, pid } = await project();
  const failed = await runRound(db, timeoutGateway().gateway, pid, { message: "ตรวจ http://127.0.0.1:4200/health ให้หน่อย" }, { today: TODAY });
  expect(failed.status).toBe("bot_could_not_answer");
  const retry = await runRound(db, stub([NOTHING]).gateway, pid, { retry: true }, { today: TODAY });
  expect(retry.status).toBe("no_changes");
  expect(retry.adjusted).toBeNull();
  expect((await apis(db, pid)).map((a) => a.key)).toEqual(["API-001"]);
});

test("an address only inside a question's text is caught; an address in a model api part is not duplicated; ., ) stripped; ftp ignored", async () => {
  const { db, pid } = await project();
  const message = "ดูที่ http://127.0.0.1:3100 (และ http://127.0.0.1:4500/health). อีกที่ http://127.0.0.1:3500/ ใช้ ftp://files.example.com/a ด้วย http://127.0.0.1:3100";
  const content = reply(
    [add("$gw", "api", "Gateway", { method: "GET", path: "http://127.0.0.1:3500" })], // E13: a model api part holds :3500 (with or without the trailing /)
    [{ text: "ให้ http://127.0.0.1:3100 ตอบ 2xx ไหม", proposedAnswer: "ใช่", cases: [] }], // a question's text holds nothing
  );
  const round = await runRound(db, stub([content]).gateway, pid, { message }, { today: TODAY });
  expect(round.status).toBe("applied");
  const stored = await apis(db, pid);
  expect(stored.map((a) => a.path)).toEqual(["http://127.0.0.1:3500", "http://127.0.0.1:3100", "http://127.0.0.1:4500/health"]);
  const kept = (round.adjusted as Adj[]).filter((a) => a.what === "url_kept");
  expect(kept.map((a) => a.title)).toEqual(["http://127.0.0.1:3100", "http://127.0.0.1:4500/health"]); // 3100 once, ")" and "." stripped, :3500 not
  expect(kept.map((a) => a.key)).toEqual(stored.slice(1).map((a) => a.key));
  expect(stored.some((a) => a.path.startsWith("ftp"))).toBe(false);
});

test("a live non-question part holds an address; a live question does not; the 21st address and later are not read", async () => {
  const { db, pid } = await project();
  const origin = { stamp: "team-proposed", date: TODAY } as const;
  const seed: Change[] = [
    { op: "part.add", ref: "$w", kind: "work", title: "งาน", body: { goal: "รันที่ http://h.test:1/" }, origin },
    { op: "part.add", ref: "$q", kind: "question", title: "q", body: { text: "http://h.test:2", cases: [], status: "open", proposedAnswer: "x" }, origin },
  ];
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: seed });
  const many = Array.from({ length: 25 }, (_, i) => `http://h.test:${i + 3}`).join(" ");
  const round = await runRound(db, stub([NOTHING]).gateway, pid, { message: `http://h.test:1 http://h.test:2 ${many}` }, { today: TODAY });
  const paths = (await apis(db, pid)).map((a) => a.path);
  expect(paths).toHaveLength(20 - 1); // 20 read in all: :1 is held by the work part, :2 is not, :3…:20 are
  expect(paths.slice(0, 2)).toEqual(["http://h.test:2", "http://h.test:3"]);
  expect(paths).not.toContain("http://h.test:1");
  expect((round.adjusted as Adj[]).filter((a) => a.what === "url_kept")).toHaveLength(19);
});

test("a model item that the server drops does not hide an address it held: the address is stored in the retried attempt", async () => {
  const { db, pid } = await project();
  // the model's api part is refused (a bad method), so the address is no longer held and the server keeps it
  const bad = reply([add("$gw", "api", "Gateway", { method: "NOPE", path: "http://127.0.0.1:3500" })]);
  const round = await runRound(db, stub([bad, bad]).gateway, pid, { message: "ที่อยู่ http://127.0.0.1:3500" }, { today: TODAY });
  expect(round.status).toBe("changes_rejected"); // nothing of the model's answer was stored, yet the address is (a URL item counts as a decision)
  expect((await apis(db, pid)).map((a) => a.path)).toEqual(["http://127.0.0.1:3500"]);
  expect((round.adjusted as Adj[] | null)?.filter((a) => a.what === "url_kept")).toHaveLength(1);
});

// --- SPEC-113 (REQ-116, TASK-142): an address stops at Thai text (E15); "held" means the same address (E16) ---------------

const keptTitles = (round: { adjusted: unknown }) => ((round.adjusted ?? []) as Adj[]).filter((a) => a.what === "url_kept").map((a) => a.title);
const seeded = async (goal: string) => {
  const { db, pid } = await project();
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: [
    { op: "part.add", ref: "$w", kind: "work", title: "งาน", body: { goal }, origin: { stamp: "team-proposed", date: TODAY } }] });
  return { db, pid };
};

test("AC-1 (DEF-2): Thai glued after the address ends it — the part's path is exactly the address", async () => {
  const { db, pid } = await project();
  const round = await runRound(db, stub([NOTHING]).gateway, pid, { message: "ช่วยตรวจที่http://127.0.0.1:4500/healthทุก 10 วินาที" }, { today: TODAY });
  expect((await apis(db, pid)).map((a) => a.path)).toEqual(["http://127.0.0.1:4500/health"]);
  expect(keptTitles(round)).toEqual(["http://127.0.0.1:4500/health"]);
});

test("AC-2 (DEF-3): a part holding :31000 does not hide :3100 — one url_kept, the :31000 part is untouched", async () => {
  const { db, pid } = await project();
  const content = reply([add("$t", "system", "บริการทดสอบ http://127.0.0.1:31000", {})]);
  const round = await runRound(db, stub([content]).gateway, pid, { message: "ตรวจ http://127.0.0.1:3100 ด้วยครับ" }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(keptTitles(round)).toEqual(["http://127.0.0.1:3100"]);
  expect((await apis(db, pid)).map((a) => a.path)).toEqual(["http://127.0.0.1:3100"]);
  expect((await loadSpec(db, pid)).parts.find((p) => p.kind === "system")!.title).toBe("บริการทดสอบ http://127.0.0.1:31000");
});

test("held = the same address: …:9/api does not hold …:9 (kept); …:9/ does (the trailing-slash rule)", async () => {
  const longer = await seeded("เปิดที่ http://h.test:9/api เท่านั้น");
  const r1 = await runRound(longer.db, stub([NOTHING]).gateway, longer.pid, { message: "ใช้ http://h.test:9" }, { today: TODAY });
  expect(keptTitles(r1)).toEqual(["http://h.test:9"]);
  const same = await seeded("เปิดที่ http://h.test:9/ เท่านั้น");
  const r2 = await runRound(same.db, stub([NOTHING]).gateway, same.pid, { message: "ใช้ http://h.test:9" }, { today: TODAY });
  expect(keptTitles(r2)).toEqual([]);
  expect(await apis(same.db, same.pid)).toEqual([]);
});

test("Thai glued on both sides: ดูที่http://h.test:7/xแล้วนะ → http://h.test:7/x", async () => {
  const { db, pid } = await project();
  const round = await runRound(db, stub([NOTHING]).gateway, pid, { message: "ดูที่http://h.test:7/xแล้วนะ" }, { today: TODAY });
  expect((await apis(db, pid)).map((a) => a.path)).toEqual(["http://h.test:7/x"]);
  expect(keptTitles(round)).toEqual(["http://h.test:7/x"]);
});
