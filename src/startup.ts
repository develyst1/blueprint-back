// SPEC-121 D2 (REQ-123): what blueprint-back checks before it listens. Every problem is ONE line — "blueprint-back: <text> — see
// README § Configuration" — which `src/index.ts` prints to stderr before it exits 1. Never the value of DATABASE_URL: it may hold
// a password. Settings that have a default (HOST, SOURCES_DIR, GATEWAY_URL, GATEWAY_LIGHT_MODEL, CAW_NOTIFY_URL) are not checked here.
import { readFileSync } from "node:fs";

const line = (text: string) => `blueprint-back: ${text} — see README § Configuration`;

export function checkSettings(env: Record<string, string | undefined>): string | null {
  const url = env.DATABASE_URL ?? "";
  if (url === "") return line("missing required setting DATABASE_URL");
  if (url !== "pglite:memory") {
    let protocol = "";
    try { protocol = new URL(url).protocol; } catch { /* not a URL: reported below, without the value */ }
    if (protocol !== "postgres:" && protocol !== "postgresql:") return line("wrong setting DATABASE_URL (not pglite:memory or a postgres:// URL)");
  }
  // `!== ""`, not truthiness: Bun loads `.env` itself, and an empty `PORT=` there arrives as "" and means the default.
  const port = env.PORT;
  if (port !== undefined && port !== "" && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    return line(`wrong setting PORT ("${port}" is not a port number)`);
  }
  return null;
}

// The number of migrations the code ships (entries of drizzle's journal) — what a migrated database must have applied.
export function migrationsShipped(): number {
  const journal = JSON.parse(readFileSync(new URL("./db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

// Same resolution as `src/scripts/migrate.ts`: drizzle wraps the Postgres error, so its code can be on `cause`.
const codeOf = (err: unknown): string => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && code !== "" ? code : "none";
};

// `applied` = how many migrations the database has applied: `select count(*) from drizzle.__drizzle_migrations` (drizzle's default
// table; `src/scripts/migrate.ts` passes no override). Postgres only — a `pglite:memory` database is migrated by `createDb` itself.
export async function checkDatabase(applied: () => Promise<number>, shipped: number = migrationsShipped()): Promise<string | null> {
  try {
    return (await applied()) < shipped ? line("database is not migrated — run bun run db:migrate") : null;
  } catch (err) {
    const code = codeOf(err);
    return code === "42P01" ? line("database is not migrated — run bun run db:migrate") : line(`wrong setting DATABASE_URL (cannot reach the database, code ${code})`);
  }
}

// For `checkDatabase`, over a `postgres` client (one connection, one query).
export const countOnPostgres = (sql: { unsafe(query: string): PromiseLike<Record<string, unknown>[]> }) => async (): Promise<number> =>
  Number((await sql.unsafe("select count(*) as n from drizzle.__drizzle_migrations"))[0]!.n);

export const listenLine = (host: string, port: number, err: unknown) => line(`cannot listen on ${host}:${port} (${codeOf(err)})`);
