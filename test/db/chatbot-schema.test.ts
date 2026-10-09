import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "../../src/db/schema";
import { testDb } from "../helpers/db";

const REAL = new URL("../../src/db/migrations", import.meta.url).pathname;
const origin = JSON.stringify({ stamp: "operator", date: "2026-10-09" });

// A copy of the migrations folder that stops at `lastIdx` — the database as it was before a later migration.
function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-migrations-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(REAL, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[]) copyFileSync(join(REAL, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

// Drizzle wraps a failed query; the Postgres error (and its SQLSTATE) is its `cause`.
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { const x = e as { code?: string; cause?: { code?: string } }; return x.cause?.code ?? x.code ?? "none"; }
  throw new Error("expected the query to be rejected");
}

test("a project that existed before 0004 reads model tier:medium and creativity 0.5 after it", async () => {
  const old = migrationsUpTo(3);
  try {
    const db = drizzle({ client: new PGlite() });
    await migrate(db, { migrationsFolder: old });
    await db.execute(sql`insert into projects (name) values ('เก่า')`);
    await migrate(db, { migrationsFolder: REAL });
    const { rows } = await db.execute(sql`select name, model, creativity from projects`);
    expect(rows).toEqual([{ name: "เก่า", model: "tier:medium", creativity: 0.5 }]);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

test("creativity outside 0–2 is refused by the database", async () => {
  const db = await testDb();
  expect(await codeOf(db.execute(sql`insert into projects (name, creativity) values ('x', 2.5)`))).toBe("23514");
  expect(await codeOf(db.execute(sql`insert into projects (name, creativity) values ('x', -0.1)`))).toBe("23514");
});

test("the same file (same sha256) cannot be added twice to one project", async () => {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  const id = p!.id;
  const add = () => db.execute(sql`insert into sources (project_id, kind, name, sha256, size, stored_as, status, origin)
    values (${id}, 'file', 'a.pdf', ${"ab".repeat(32)}, 10, 'ab/abab', 'read', ${origin}::jsonb)`);
  await add();
  expect(await codeOf(add())).toBe("23505");
});
