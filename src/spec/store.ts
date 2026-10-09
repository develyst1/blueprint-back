import { and, asc, eq, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { changes, changeSets, links, parts, projects } from "../db/schema";
import { NotFound, UndoConflict, ValidationError } from "./errors";
import { compareKeys, KEY_RE, nextKey } from "./keys";
import { checkLink, LINK_KINDS, PART_KINDS, type LinkKind, type PartKind } from "./registry";
import { Cause, Change, Origin, type HistoryEntry, type Link, type Part } from "./types";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;
type PartRow = typeof parts.$inferSelect;
type LinkRow = typeof links.$inferSelect;

// The "comparable form" every `changes` row stores as before/after (null = absent).
type PartForm = { key: string; kind: string; title: string; body: unknown; origin: unknown; removed: boolean };
type LinkForm = {
  id: string; kind: string; fromKey: string; toKey: string;
  position: number | null; label: string | null; origin: unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const partForm = (r: PartRow): PartForm =>
  ({ key: r.key!, kind: r.kind, title: r.title, body: r.body, origin: r.origin, removed: r.removedAt !== null });
const linkForm = (r: LinkRow): LinkForm =>
  ({ id: r.id, kind: r.kind, fromKey: r.fromKey, toKey: r.toKey, position: r.position, label: r.label, origin: r.origin });

// Deep equality that ignores key order inside objects (jsonb does not keep it).
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function compareLinks(a: LinkForm, b: LinkForm): number {
  return compareKeys(a.fromKey, b.fromKey)
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.position ?? Infinity) - (b.position ?? Infinity)
    || compareKeys(a.toKey, b.toKey);
}

async function requireProject(q: Q, projectId: string, lock = false): Promise<void> {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  const query = q.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  const found = lock ? await query.for("update") : await query;
  if (found.length === 0) throw new NotFound("project");
}

async function partRow(q: Q, projectId: string, key: string): Promise<PartRow | undefined> {
  if (!KEY_RE.test(key)) return undefined;
  const [row] = await q.select().from(parts).where(and(eq(parts.projectId, projectId), eq(parts.key, key)));
  return row;
}

async function linkRow(q: Q, projectId: string, id: string): Promise<LinkRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await q.select().from(links).where(and(eq(links.projectId, projectId), eq(links.id, id)));
  return row;
}

function bodyOf(kind: PartKind, body: unknown): { ok: true; body: unknown } | { ok: false; message: string } {
  const r = PART_KINDS[kind].body.safeParse(body);
  return r.success ? { ok: true, body: r.data } : { ok: false, message: `${kind} body: ${z.prettifyError(r.error)}` };
}

export async function loadSpec(db: Db, projectId: string): Promise<{ parts: Part[]; links: Link[] }> {
  await requireProject(db, projectId);
  const rows = await db.select().from(parts).where(and(eq(parts.projectId, projectId), isNull(parts.removedAt)));
  // A part's `createdIn` is the change set holding its add row (before = null) — derived, never stored.
  const adds = await db.select({ entity: changes.entity, changeSetId: changes.changeSetId })
    .from(changes).innerJoin(changeSets, eq(changes.changeSetId, changeSets.id))
    .where(and(eq(changeSets.projectId, projectId), like(changes.entity, "part:%"), isNull(changes.before)))
    .orderBy(asc(changeSets.at), asc(changes.seq));
  const createdIn = new Map<string, string>();
  for (const a of adds) if (!createdIn.has(a.entity)) createdIn.set(a.entity, a.changeSetId!);

  const ps: Part[] = rows.sort((a, b) => compareKeys(a.key!, b.key!)).map((r) => {
    const cs = createdIn.get(`part:${r.key}`);
    if (!cs) throw new Error(`integrity: project ${projectId} part ${r.key} has no add row in its history`);
    return { key: r.key!, kind: r.kind as PartKind, title: r.title, body: r.body as Record<string, unknown>,
      origin: r.origin as Origin, createdIn: cs };
  });
  const ls = (await db.select().from(links).where(eq(links.projectId, projectId)))
    .map(linkForm).sort(compareLinks)
    .map((l) => ({ ...l, kind: l.kind as LinkKind, origin: l.origin as Origin }));
  return { parts: ps, links: ls };
}

// `opts.inTx` runs after the last change is written and before commit, on the same transaction; if it throws, the
// whole change set is rolled back (TASK-A-023: the chat's bot row is written this way, so a set never lands alone).
export async function applyChangeSet(
  db: Db,
  projectId: string,
  input: { cause: Cause; changes: Change[] },
  opts?: { inTx?: (tx: Tx, result: { changeSetId: string; keys: Record<string, string> }) => Promise<void> },
): Promise<{ changeSetId: string; keys: Record<string, string> }> {
  if (input.changes.length === 0) throw new ValidationError(null, "a change set needs at least one change");
  const cause = Cause.safeParse(input.cause);
  if (!cause.success) throw new ValidationError(null, `cause: ${z.prettifyError(cause.error)}`);

  return db.transaction(async (tx) => {
    // One change set at a time per project: keys and undo checks read then write.
    await requireProject(tx, projectId, true);
    const [cs] = await tx.insert(changeSets)
      .values({ projectId, causeKind: cause.data.kind, causeRef: cause.data.ref ?? null }).returning();
    const allKeys = (await tx.select({ key: parts.key }).from(parts).where(eq(parts.projectId, projectId)))
      .map((r) => r.key!);
    const refs = new Map<string, string>();
    let seq = 0;
    const record = (entity: string, before: unknown, after: unknown) =>
      tx.insert(changes).values({ changeSetId: cs!.id, seq: ++seq, entity, before, after });

    for (const [index, raw] of input.changes.entries()) {
      const bad = (message: string) => new ValidationError(index, message);
      const parsed = Change.safeParse(raw);
      if (!parsed.success) throw bad(z.prettifyError(parsed.error));
      const c = parsed.data;

      const livePart = async (keyOrRef: string) => {
        const key = refs.get(keyOrRef) ?? keyOrRef;
        const row = await partRow(tx, projectId, key);
        if (!row || row.removedAt) throw bad(`no live part "${keyOrRef}"`);
        return row;
      };

      switch (c.op) {
        case "part.add": {
          if (refs.has(c.ref)) throw bad(`ref ${c.ref} is used twice`);
          const body = bodyOf(c.kind, c.body);
          if (!body.ok) throw bad(body.message);
          const key = nextKey(c.kind, allKeys);
          allKeys.push(key);
          const [row] = await tx.insert(parts)
            .values({ projectId, key, kind: c.kind, title: c.title, body: body.body, origin: c.origin }).returning();
          await record(`part:${key}`, null, partForm(row!));
          refs.set(c.ref, key);
          break;
        }
        case "part.update": {
          const row = await livePart(c.key);
          // A given body replaces the stored one whole (SPEC-A-001, TASK-A-004 Q1); omitted keeps it.
          const body = bodyOf(row.kind as PartKind, c.body ?? row.body);
          if (!body.ok) throw bad(body.message);
          const [updated] = await tx.update(parts)
            .set({ title: c.title ?? row.title, body: body.body, origin: c.origin ?? row.origin })
            .where(and(eq(parts.projectId, projectId), eq(parts.key, row.key!))).returning();
          await record(`part:${row.key}`, partForm(row), partForm(updated!));
          break;
        }
        case "part.remove": {
          const row = await livePart(c.key);
          const touching = (await tx.select().from(links).where(and(eq(links.projectId, projectId),
            or(eq(links.fromKey, row.key!), eq(links.toKey, row.key!))))).map(linkForm).sort(compareLinks);
          for (const l of touching) {
            await tx.delete(links).where(eq(links.id, l.id));
            await record(`link:${l.id}`, l, null);
          }
          const [removed] = await tx.update(parts).set({ removedAt: new Date() })
            .where(and(eq(parts.projectId, projectId), eq(parts.key, row.key!))).returning();
          await record(`part:${row.key}`, partForm(row), partForm(removed!));
          break;
        }
        case "link.add": {
          const from = await livePart(c.from);
          const to = await livePart(c.to);
          const why = checkLink({ kind: c.kind, fromKind: from.kind, toKind: to.kind, position: c.position, label: c.label });
          if (why) throw bad(why);
          let position: number | null = null;
          if (LINK_KINDS[c.kind].ordered) {
            if (c.position !== undefined) position = c.position;
            else {
              const [{ max }] = await tx.select({ max: sql<number | null>`max(${links.position})` }).from(links)
                .where(and(eq(links.projectId, projectId), eq(links.fromKey, from.key!), eq(links.kind, c.kind)));
              position = (max ?? 0) + 1;
            }
          }
          const [row] = await tx.insert(links).values({
            projectId, kind: c.kind, fromKey: from.key!, toKey: to.key!, position, label: c.label ?? null, origin: c.origin,
          }).returning();
          await record(`link:${row!.id}`, null, linkForm(row!));
          break;
        }
        case "link.update": {
          const row = await linkRow(tx, projectId, c.id);
          if (!row) throw bad(`no link "${c.id}"`);
          const from = await livePart(row.fromKey);
          const to = await livePart(row.toKey);
          const why = checkLink({ kind: row.kind, fromKind: from.kind, toKind: to.kind, position: c.position, label: c.label });
          if (why) throw bad(why);
          const [updated] = await tx.update(links)
            .set({ position: c.position ?? row.position, label: c.label ?? row.label })
            .where(eq(links.id, row.id)).returning();
          await record(`link:${row.id}`, linkForm(row), linkForm(updated!));
          break;
        }
        case "link.remove": {
          const row = await linkRow(tx, projectId, c.id);
          if (!row) throw bad(`no link "${c.id}"`);
          await tx.delete(links).where(eq(links.id, row.id));
          await record(`link:${row.id}`, linkForm(row), null);
          break;
        }
      }
    }
    const result = { changeSetId: cs!.id, keys: Object.fromEntries(refs) };
    if (opts?.inTx) await opts.inTx(tx, result);
    return result;
  });
}

function historyOp(entity: string, before: any, after: any): HistoryEntry["op"] {
  if (entity.startsWith("link:")) return before === null ? "link_add" : after === null ? "link_remove" : "link_update";
  if (before === null) return "add";
  if (!before.removed && after.removed) return "remove";
  if (before.removed && !after.removed) return "restore";
  return "update";
}

export async function partHistory(db: Db, projectId: string, key: string): Promise<HistoryEntry[]> {
  await requireProject(db, projectId);
  if (!(await partRow(db, projectId, key))) throw new NotFound(`part ${key}`);
  const touches = (side: typeof changes.before | typeof changes.after) =>
    or(sql`${side}->>'fromKey' = ${key}`, sql`${side}->>'toKey' = ${key}`);
  const rows = await db.select({
    changeSetId: changes.changeSetId, at: changeSets.at, causeKind: changeSets.causeKind, causeRef: changeSets.causeRef,
    entity: changes.entity, before: changes.before, after: changes.after,
  }).from(changes).innerJoin(changeSets, eq(changes.changeSetId, changeSets.id))
    .where(and(eq(changeSets.projectId, projectId), or(
      eq(changes.entity, `part:${key}`),
      and(like(changes.entity, "link:%"), or(touches(changes.before), touches(changes.after))),
    )))
    .orderBy(asc(changeSets.at), asc(changes.seq));
  return rows.map((r) => ({
    changeSetId: r.changeSetId!,
    at: r.at.toISOString(),
    cause: { kind: r.causeKind as HistoryEntry["cause"]["kind"], ...(r.causeRef ? { ref: r.causeRef } : {}) },
    entity: r.entity,
    op: historyOp(r.entity, r.before, r.after),
    before: r.before,
    after: r.after,
  }));
}

export async function undoChangeSet(db: Db, projectId: string, changeSetId: string): Promise<{ changeSetId: string }> {
  return db.transaction((tx) => undoIn(tx, projectId, changeSetId));
}

class DryRun extends Error {}

// TASK-A-030: `undoable` = exactly what `undoChangeSet` would decide right now. The undo refuses in three places (changed
// since, a link end removed since, a part linked since — two of them only while writing), so the read runs the same
// `undoIn` in a transaction that is always rolled back, and keeps only "refused or not". Nothing it writes survives.
async function wouldUndo(db: Db, projectId: string, changeSetId: string): Promise<boolean> {
  try {
    await db.transaction(async (tx) => { await undoIn(tx, projectId, changeSetId); throw new DryRun(); });
  } catch (e) {
    if (e instanceof DryRun) return true;
    if (e instanceof UndoConflict) return false;
    throw e;
  }
  throw new Error("unreachable: a dry-run undo always rolls back");
}

export type ChangeSetRead = {
  id: string; at: string; cause: { kind: string; ref: string | null };
  counts: { added: number; updated: number; removed: number }; entities: string[]; undoable: boolean;
};

// SPEC-A-006 § C1: one change set for the chat's change card — counts from its `changes` rows (link rows count too).
export async function readChangeSet(db: Db, projectId: string, changeSetId: string): Promise<ChangeSetRead> {
  await requireProject(db, projectId);
  const [cs] = UUID_RE.test(changeSetId)
    ? await db.select().from(changeSets).where(and(eq(changeSets.id, changeSetId), eq(changeSets.projectId, projectId)))
    : [];
  if (!cs) throw new NotFound("change set");
  const rows = await db.select().from(changes).where(eq(changes.changeSetId, changeSetId)).orderBy(asc(changes.seq));
  const counts = { added: 0, updated: 0, removed: 0 };
  for (const r of rows) counts[r.before === null ? "added" : r.after === null ? "removed" : "updated"]++;
  return {
    id: cs.id, at: cs.at.toISOString(), cause: { kind: cs.causeKind, ref: cs.causeRef },
    counts, entities: [...new Set(rows.map((r) => r.entity))], undoable: await wouldUndo(db, projectId, changeSetId),
  };
}

async function undoIn(tx: Tx, projectId: string, changeSetId: string): Promise<{ changeSetId: string }> {
  await requireProject(tx, projectId, true);
  const [original] = UUID_RE.test(changeSetId)
    ? await tx.select().from(changeSets).where(and(eq(changeSets.id, changeSetId), eq(changeSets.projectId, projectId)))
    : [];
  if (!original) throw new NotFound("change set");
  const rows = await tx.select().from(changes).where(eq(changes.changeSetId, changeSetId)).orderBy(asc(changes.seq));

  const current = async (entity: string): Promise<PartForm | LinkForm | null> => {
    const [type, id] = [entity.slice(0, entity.indexOf(":")), entity.slice(entity.indexOf(":") + 1)];
    if (type === "part") { const r = await partRow(tx, projectId, id); return r ? partForm(r) : null; }
    const r = await linkRow(tx, projectId, id);
    return r ? linkForm(r) : null;
  };
  const partKeyOf = (entity: string, before: any, after: any): string =>
    entity.startsWith("part:") ? entity.slice(5) : (after ?? before).fromKey;
  const conflict = async (keys: Iterable<string>) => {
    const sorted = [...new Set(keys)].sort(compareKeys);
    const named = [];
    for (const key of sorted) {
      const row = await partRow(tx, projectId, key);
      if (!row) throw new Error(`integrity: project ${projectId} has history for part ${key} but no row`);
      named.push({ key, title: row.title });
    }
    return new UndoConflict(named);
  };

  // Refuse if anything in the set was changed again since (AC-8): newer work is never overwritten.
  const changedSince: string[] = [];
  for (const r of rows) {
    if (!same(await current(r.entity), r.after)) changedSince.push(partKeyOf(r.entity, r.before, r.after));
  }
  if (changedSince.length) throw await conflict(changedSince);

  const [cs] = await tx.insert(changeSets)
    .values({ projectId, causeKind: "undo", undoes: changeSetId }).returning();
  let seq = 0;
  const record = (entity: string, before: unknown, after: unknown) =>
    tx.insert(changes).values({ changeSetId: cs!.id, seq: ++seq, entity, before, after });
  const nowRemoved: string[] = [];
  const blocked: string[] = [];

  // Reverse order: a part is restored before its links come back (the database refuses the other way).
  for (const r of [...rows].reverse()) {
    const now = await current(r.entity);
    if (r.entity.startsWith("part:")) {
      const key = r.entity.slice(5);
      const target = r.before as PartForm | null;
      // A part row is never deleted, so its key is never reused: undoing an add removes it.
      const set = target === null
        ? { removedAt: new Date() }
        : { title: target.title, body: target.body, origin: target.origin, removedAt: target.removed ? new Date() : null };
      const [row] = await tx.update(parts).set(set)
        .where(and(eq(parts.projectId, projectId), eq(parts.key, key))).returning();
      if (row!.removedAt) nowRemoved.push(key);
      await record(r.entity, now, partForm(row!));
    } else {
      const target = r.before as LinkForm | null;
      if (target === null) {
        await tx.delete(links).where(eq(links.id, (now as LinkForm).id));
        await record(r.entity, now, null);
      } else if (now === null) {
        // An end removed by a later set is newer work: refuse rather than let the database throw.
        const deadEnds = [];
        for (const key of [target.fromKey, target.toKey]) {
          if ((await partRow(tx, projectId, key))?.removedAt) deadEnds.push(key);
        }
        if (deadEnds.length) { blocked.push(...deadEnds); continue; }
        const [row] = await tx.insert(links).values({ ...target, projectId }).returning();
        await record(r.entity, null, linkForm(row!));
      } else {
        const [row] = await tx.update(links).set({ position: target.position, label: target.label })
          .where(eq(links.id, target.id)).returning();
        await record(r.entity, now, linkForm(row!));
      }
    }
  }

  // A part this undo removes may have gained links in a later set — that is newer work too.
  for (const key of nowRemoved) {
    const touching = await tx.select({ id: links.id }).from(links)
      .where(and(eq(links.projectId, projectId), or(eq(links.fromKey, key), eq(links.toKey, key))));
    if (touching.length) blocked.push(key);
  }
  if (blocked.length) throw await conflict(blocked);

  return { changeSetId: cs!.id };
}
