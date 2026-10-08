import { createDb, type Db } from "../../src/db/client";

export async function testDb(): Promise<Db> {
  return createDb("pglite:memory");
}
