import postgres from "postgres";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { checkDatabase, checkSettings, countOnPostgres, listenLine } from "./startup";

// SPEC-121 D2: the settings first, then (a real database only) its migrations; any problem is one line on stderr and exit 1.
const problem = checkSettings(process.env);
if (problem) {
  console.error(problem);
  process.exit(1);
}
// Never print the URL itself — it may hold a password.
const url = process.env.DATABASE_URL!;
if (url !== "pglite:memory") {
  // one connection, one query, ended before `createDb` makes its own
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let notReady: string | null;
  try { notReady = await checkDatabase(countOnPostgres(sql)); } finally { await sql.end(); }
  if (notReady) {
    console.error(notReady);
    process.exit(1);
  }
}

const app = createApp(await createDb(url));
// `||`, not `??`: Bun loads `.env` itself, and an empty `PORT=` there arrives as "" (TASK-A-001 Q1).
// This machine only unless HOST says otherwise: v1 has no login (SPEC-A-001 § Non-functional).
const hostname = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4200);
try {
  Bun.serve({ hostname, port, fetch: app.fetch });
} catch (err) {
  console.error(listenLine(hostname, port, err));
  process.exit(1);
}
