// The database rules of test/db/rules.test.ts, run against SIT Postgres (REQ-001 Addendum A).
// Runs only with BLUEPRINT_SIT=1. Every check runs in one transaction that is rolled back — nothing is committed.
// 🔴 Never print the connection string or a database error's message: errors leave this file as code only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client";
import { changeSets, links, organisations, parts, projects, versions } from "../../src/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const origin = { stamp: "operator", date: "2026-10-08" };
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

// A database or driver error carries a code (SQLSTATE or a socket code) or a cause; an assertion error carries neither.
function isDbError(e: unknown): boolean {
  const x = e as { code?: unknown; cause?: unknown; constructor?: { name?: string } } | null;
  return !!x && (x.code !== undefined || x.cause !== undefined
    || ["DrizzleQueryError", "PostgresError"].includes(x.constructor?.name ?? ""));
}
const codeOf = (e: unknown): string => {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.cause?.code ?? x.code ?? "none";
};
// The Postgres message, for matching inside a test only — never printed.
const messageOf = (e: unknown): string => {
  const x = e as { message?: string; cause?: { message?: string } };
  return x.cause?.message ?? x.message ?? "";
};
const sanitise = (e: unknown) => (isDbError(e) ? new Error(`SIT database error — code ${codeOf(e)}`) : e);

class Rollback extends Error {}

describe.skipIf(process.env.BLUEPRINT_SIT !== "1")("SIT Postgres rules (skipped unless BLUEPRINT_SIT=1)", () => {
  let db: Db;

  beforeAll(async () => {
    try { db = await createDb(process.env.DATABASE_URL!); } catch (e) { throw sanitise(e); }
  });
  afterAll(async () => {
    await (db as unknown as { $client?: { end?: () => Promise<void> } })?.$client?.end?.();
  });

  // Runs `fn` in a transaction that always ends in a rollback.
  async function rolledBack(fn: (tx: Tx) => Promise<void>) {
    try {
      await db.transaction(async (tx) => { await fn(tx); throw new Rollback(); });
    } catch (e) {
      if (!(e instanceof Rollback)) throw sanitise(e);
    }
  }

  // Runs `fn` inside a savepoint; on a database error rolls back to it and returns that error.
  async function attempt(tx: Tx, fn: () => Promise<unknown>): Promise<unknown> {
    await tx.execute(sql`SAVEPOINT a`);
    try {
      await fn();
      await tx.execute(sql`RELEASE SAVEPOINT a`);
      return null;
    } catch (e) {
      if (!isDbError(e)) throw e;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT a`);
      return e;
    }
  }

  async function project(tx: Tx) {
    const [p] = await tx.insert(projects).values({ name: "SIT check" }).returning();
    return p!;
  }

  test("1. a version row cannot be updated or deleted", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      const [cs] = await tx.insert(changeSets).values({ projectId: p.id, causeKind: "operator" }).returning();
      await tx.insert(versions).values({
        projectId: p.id, version: 1, confirmedBy: "operator", snapshot: {}, summary: {}, lastChangeSet: cs!.id,
      });
      const upd = await attempt(tx, () => tx.update(versions).set({ confirmedBy: "someone" }).where(eq(versions.projectId, p.id)).execute());
      expect(codeOf(upd)).toBe("P0001");
      expect(/immutable/.test(messageOf(upd))).toBe(true);
      const del = await attempt(tx, () => tx.delete(versions).where(eq(versions.projectId, p.id)).execute());
      expect(codeOf(del)).toBe("P0001");
      expect(/immutable/.test(messageOf(del))).toBe(true);
      const [row] = await tx.select().from(versions).where(eq(versions.projectId, p.id));
      expect(row!.confirmedBy).toBe("operator");
    });
  });

  test("2. a link cannot touch a removed part", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      await tx.insert(parts).values([
        { projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin, removedAt: new Date() },
        { projectId: p.id, key: "ROLE-002", kind: "role", title: "b", origin },
      ]);
      const err = await attempt(tx, () => tx.insert(links)
        .values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-002", origin }).execute());
      expect(err).not.toBeNull();
      expect(/removed part/.test(messageOf(err))).toBe(true);
    });
  });

  test("3. removing a linked part fails at the commit-time check; unlinking first passes", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      await tx.insert(parts).values([
        { projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin },
        { projectId: p.id, key: "ROLE-002", kind: "role", title: "b", origin },
      ]);
      const [l] = await tx.insert(links)
        .values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-002", origin }).returning();
      const removeRole1 = () => tx.update(parts).set({ removedAt: new Date() })
        .where(sql`${parts.projectId} = ${p.id} and ${parts.key} = 'ROLE-001'`).execute();

      const linked = await attempt(tx, async () => {
        await removeRole1();
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      });
      expect(linked).not.toBeNull();
      expect(/still linked/.test(messageOf(linked))).toBe(true);

      const unlinked = await attempt(tx, async () => {
        await tx.delete(links).where(eq(links.id, l!.id)).execute();
        await removeRole1();
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      });
      expect(unlinked).toBeNull();
    });
  });

  test("4. a project without an organisation gets the default one", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      expect(p.organisationId).toBe(DEFAULT_ORG);
      const [org] = await tx.select().from(organisations).where(eq(organisations.id, DEFAULT_ORG));
      expect(org!.name).toBe("default");
    });
  });

  test("5. a link to a part that does not exist is rejected by the foreign key", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      await tx.insert(parts).values({ projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin });
      const err = await attempt(tx, () => tx.insert(links)
        .values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-999", origin }).execute());
      expect(codeOf(err)).toBe("23503");
    });
  });

  test("6. a Thai title round-trips byte-identical", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      const title = "เปลี่ยนแพ็กเกจหลัก / แพ็กเกจเสริม";
      await tx.insert(parts).values({ projectId: p.id, key: "WRK-001", kind: "work", title, origin });
      const [row] = await tx.select().from(parts).where(sql`${parts.projectId} = ${p.id} and ${parts.key} = 'WRK-001'`);
      expect(Buffer.from(row!.title).equals(Buffer.from(title))).toBe(true);
    });
  });

  test("7. a confirmed version cannot be truncated", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      const [cs] = await tx.insert(changeSets).values({ projectId: p.id, causeKind: "operator" }).returning();
      await tx.insert(versions).values({
        projectId: p.id, version: 1, confirmedBy: "operator", snapshot: {}, summary: {}, lastChangeSet: cs!.id,
      });
      for (const statement of [sql`truncate versions`, sql`truncate projects cascade`]) {
        const err = await attempt(tx, () => tx.execute(statement));
        expect(codeOf(err)).toBe("P0001");
        expect(/immutable/.test(messageOf(err))).toBe(true);
      }
      const rows = await tx.select().from(versions).where(eq(versions.projectId, p.id));
      expect(rows).toHaveLength(1);
    });
  });

  test("8. a project without a theme reads clean-blue; an empty theme is refused", async () => {
    await rolledBack(async (tx) => {
      const p = await project(tx);
      expect(p.theme).toBe("clean-blue");
      const err = await attempt(tx, () => tx.execute(sql`insert into projects (name, theme) values ('x', '')`));
      expect(codeOf(err)).toBe("23514");
    });
  });

  test("9. nothing was left behind (AC-A4), and the schema is the seven tables", async () => {
    try {
      const [{ n }] = await db.select({ n: count() }).from(projects);
      expect(n).toBe(0);
      const tables = (await db.execute(sql`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`)) as unknown as { table_name: string }[];
      const names = [...tables].map((t) => t.table_name);
      console.log(`public tables: ${names.join(", ")}`);
      expect(names).toEqual(["change_sets", "changes", "links", "organisations", "parts", "projects", "versions"]);
    } catch (e) {
      throw sanitise(e);
    }
  });
});
