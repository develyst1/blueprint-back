// SPEC-121 D2 (REQ-123, TASK-155): the start checks. Every line is D2's text exactly. Only in-memory PGlite and a connection to a
// port nothing listens on (127.0.0.1:1) — no real database.
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { checkDatabase, checkSettings, countOnPostgres, listenLine, migrationsShipped } from "../src/startup";

const SEE = "— see README § Configuration";
const migrationsFolder = new URL("../src/db/migrations", import.meta.url).pathname;
const countOnPglite = (pg: PGlite) => async () =>
  Number(((await pg.query("select count(*) as n from drizzle.__drizzle_migrations")).rows[0] as { n: unknown }).n);

test("(a) DATABASE_URL: missing and empty → the missing line; mysql:// and not a URL → the wrong line; the three good forms → null", () => {
  const missing = `blueprint-back: missing required setting DATABASE_URL ${SEE}`;
  expect(checkSettings({})).toBe(missing);
  expect(checkSettings({ DATABASE_URL: "" })).toBe(missing);
  const wrong = `blueprint-back: wrong setting DATABASE_URL (not pglite:memory or a postgres:// URL) ${SEE}`;
  expect(checkSettings({ DATABASE_URL: "mysql://x" })).toBe(wrong);
  expect(checkSettings({ DATABASE_URL: "not a url" })).toBe(wrong);
  for (const ok of ["pglite:memory", "postgres://u@h/blueprint", "postgresql://u:p@h:5432/blueprint"]) expect(checkSettings({ DATABASE_URL: ok })).toBeNull();
  // the line never holds the value
  expect(checkSettings({ DATABASE_URL: "mysql://user:secret@h/db" })).not.toContain("secret");
});

test("(a) PORT: abc, 0, 70000, 4200x → the wrong line with the value; unset, empty, 4200 → null", () => {
  const base = { DATABASE_URL: "pglite:memory" };
  for (const bad of ["abc", "0", "70000", "4200x"]) {
    expect(checkSettings({ ...base, PORT: bad })).toBe(`blueprint-back: wrong setting PORT ("${bad}" is not a port number) ${SEE}`);
  }
  for (const ok of [undefined, "", "4200", "1", "65535"]) expect(checkSettings({ ...base, PORT: ok })).toBeNull();
  // DATABASE_URL is checked first
  expect(checkSettings({ PORT: "abc" })).toBe(`blueprint-back: missing required setting DATABASE_URL ${SEE}`);
});

test("(b) a PGlite without migrations → the not-migrated line; with every migration → null; one behind → the not-migrated line", async () => {
  const notMigrated = `blueprint-back: database is not migrated — run bun run db:migrate ${SEE}`;
  const bare = new PGlite();
  expect(await checkDatabase(countOnPglite(bare))).toBe(notMigrated); // drizzle.__drizzle_migrations does not exist (42P01)
  const full = new PGlite();
  await migrate(drizzle({ client: full }), { migrationsFolder });
  expect(await checkDatabase(countOnPglite(full))).toBeNull();
  expect(migrationsShipped()).toBeGreaterThanOrEqual(12);
  expect(await checkDatabase(countOnPglite(full), migrationsShipped() + 1)).toBe(notMigrated); // the code ships one the database lacks
});

test("(c) a database nothing listens on → the cannot-reach line with the code; neither the URL nor the password is in it", async () => {
  const url = "postgres://u:p@127.0.0.1:1/blueprint";
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  let line: string | null;
  try { line = await checkDatabase(countOnPostgres(sql)); } finally { await sql.end(); }
  expect(line).toBe(`blueprint-back: wrong setting DATABASE_URL (cannot reach the database, code ECONNREFUSED) ${SEE}`);
  expect(line).not.toContain("u:p");
  expect(line).not.toContain("127.0.0.1:1");
});

test("the listen line names host, port and the error's code (none when it has none)", () => {
  expect(listenLine("127.0.0.1", 4200, Object.assign(new Error("x"), { code: "EADDRINUSE" })))
    .toBe(`blueprint-back: cannot listen on 127.0.0.1:4200 (EADDRINUSE) ${SEE}`);
  expect(listenLine("0.0.0.0", 80, new Error("x"))).toBe(`blueprint-back: cannot listen on 0.0.0.0:80 (none) ${SEE}`);
});
