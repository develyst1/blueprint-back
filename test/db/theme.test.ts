import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb } from "../helpers/db";

const REAL = new URL("../../src/db/migrations", import.meta.url).pathname;

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

test("AC-B4: a project that existed before the theme column reads clean-blue after the migration", async () => {
  const old = migrationsUpTo(2);
  try {
    const db = drizzle({ client: new PGlite() });
    await migrate(db, { migrationsFolder: old });
    await db.execute(sql`insert into projects (name) values ('เก่า')`);
    await migrate(db, { migrationsFolder: REAL });
    const { rows } = await db.execute(sql`select name, theme from projects`);
    expect(rows).toEqual([{ name: "เก่า", theme: "clean-blue" }]);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

test("the database itself refuses an empty theme and one over 64 characters", async () => {
  const db = await testDb();
  expect(await codeOf(db.execute(sql`insert into projects (name, theme) values ('x', '')`))).toBe("23514");
  expect(await codeOf(db.execute(sql`insert into projects (name, theme) values ('x', ${"a".repeat(65)})`))).toBe("23514");
});
