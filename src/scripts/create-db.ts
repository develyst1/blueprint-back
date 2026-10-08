// `bun run db:create` — creates the database named in DATABASE_URL (`blueprint`) if it is missing.
// Connects to the server's `postgres` maintenance database for this one check-and-create, nothing else.
// Never prints the URL or an error message (either can hold the host or password) — only fixed text and the code.
import postgres from "postgres";

const NAME = "blueprint";

async function main(): Promise<string> {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (target.pathname !== `/${NAME}`) return `db:create stopped — DATABASE_URL does not name the ${NAME} database`;
  const admin = new URL(target);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const found = await sql`select 1 from pg_database where datname = ${NAME}`;
    if (found.length > 0) return `database ${NAME}: exists`;
    await sql.unsafe(`create database ${NAME}`);
    return `database ${NAME}: created`;
  } finally {
    await sql.end();
  }
}

try {
  console.log(await main());
} catch (err) {
  console.log(`db:create failed — code ${(err as { code?: string }).code ?? "none"}`);
  process.exit(1);
}
