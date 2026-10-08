import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { changeSets, links, organisations, parts, projects, versions } from "../../src/db/schema";
import { testDb } from "../helpers/db";

const origin = { stamp: "operator", date: "2026-10-08" };

// Drizzle wraps a failed query as "Failed query: …"; the Postgres error is its `cause`.
async function rejection(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { const err = e as Error & { cause?: Error }; return err.cause?.message ?? err.message; }
  throw new Error("expected the query to be rejected");
}

async function project(db: Awaited<ReturnType<typeof testDb>>) {
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  return p!;
}

test("AC-11 base: a version row cannot be updated or deleted", async () => {
  const db = await testDb();
  const p = await project(db);
  const [cs] = await db.insert(changeSets).values({ projectId: p.id, causeKind: "operator" }).returning();
  await db.insert(versions).values({
    projectId: p.id, version: 1, confirmedBy: "operator", snapshot: {}, summary: {}, lastChangeSet: cs!.id,
  });
  expect(await rejection(db.update(versions).set({ confirmedBy: "someone" }).execute())).toMatch(/immutable/);
  expect(await rejection(db.delete(versions).execute())).toMatch(/immutable/);
});

test("a link cannot touch a removed part", async () => {
  const db = await testDb();
  const p = await project(db);
  await db.insert(parts).values([
    { projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin, removedAt: new Date() },
    { projectId: p.id, key: "ROLE-002", kind: "role", title: "b", origin },
  ]);
  expect(await rejection(
    db.insert(links).values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-002", origin }).execute(),
  )).toMatch(/removed part/);
});

test("removing a linked part fails at commit; unlinking first commits", async () => {
  const db = await testDb();
  const p = await project(db);
  await db.insert(parts).values([
    { projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin },
    { projectId: p.id, key: "ROLE-002", kind: "role", title: "b", origin },
  ]);
  const [l] = await db.insert(links)
    .values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-002", origin }).returning();

  await expect(db.transaction(async (tx) => {
    await tx.update(parts).set({ removedAt: new Date() }).where(eq(parts.key, "ROLE-001"));
  })).rejects.toThrow(/still linked/);

  await db.transaction(async (tx) => {
    await tx.delete(links).where(eq(links.id, l!.id));
    await tx.update(parts).set({ removedAt: new Date() }).where(eq(parts.key, "ROLE-001"));
  });
  const [row] = await db.select().from(parts).where(eq(parts.key, "ROLE-001"));
  expect(row!.removedAt).not.toBeNull();
});

test("AC-12 base: a project without an organisation gets the default one", async () => {
  const db = await testDb();
  const p = await project(db);
  expect(p.organisationId).toBe("00000000-0000-0000-0000-000000000001");
  const [org] = await db.select().from(organisations).where(eq(organisations.id, p.organisationId));
  expect(org!.name).toBe("default");
});

test("a link to a part that does not exist is rejected", async () => {
  const db = await testDb();
  const p = await project(db);
  await db.insert(parts).values({ projectId: p.id, key: "ROLE-001", kind: "role", title: "a", origin });
  await expect(
    db.insert(links).values({ projectId: p.id, kind: "covers", fromKey: "ROLE-001", toKey: "ROLE-999", origin }).execute(),
  ).rejects.toThrow();
  expect(await db.select().from(links)).toHaveLength(0);
});

test("AC-2 base: a Thai title round-trips byte-identical", async () => {
  const db = await testDb();
  const p = await project(db);
  const title = "เปลี่ยนแพ็กเกจหลัก / แพ็กเกจเสริม";
  await db.insert(parts).values({ projectId: p.id, key: "WRK-001", kind: "work", title, origin });
  const [row] = await db.select().from(parts).where(eq(parts.key, "WRK-001"));
  expect(Buffer.from(row!.title).equals(Buffer.from(title))).toBe(true);
});
