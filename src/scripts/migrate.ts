// `bun run db:migrate` — applies every migration in src/db/migrations to the database in DATABASE_URL.
// Never prints the URL or an error message (either can hold the host or password) — only fixed text and the code.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Same resolution as src/db/client.ts.
const migrationsFolder = new URL("../db/migrations", import.meta.url).pathname;

const url = process.env.DATABASE_URL ?? "";
let client: ReturnType<typeof postgres> | undefined;
try {
  if (!url) throw Object.assign(new Error(), { code: "no DATABASE_URL" });
  client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle({ client }), { migrationsFolder });
  console.log("migrations applied");
} catch (err) {
  // drizzle wraps the Postgres error: its code is on `cause`.
  const e = err as { code?: string; cause?: { code?: string } };
  console.log(`db:migrate failed — code ${e.code ?? e.cause?.code ?? "none"}`);
  process.exitCode = 1;
} finally {
  await client?.end();
}
