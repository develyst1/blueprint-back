import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

// `pglite:memory` → an in-memory PGlite with every migration applied.
// Anything else is a Postgres URL; the operator migrates a real database himself.
export async function createDb(url: string): Promise<Db> {
  if (url === "pglite:memory") {
    const db = drizzlePglite({ client: new PGlite(), schema });
    await migrate(db, { migrationsFolder });
    return db;
  }
  return drizzlePostgres({ client: postgres(url), schema });
}
