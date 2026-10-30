// SPEC-106 (REQ-105): the seam, v2 — Blueprint serves the LATEST spec, named by a revision number, plus a feed of what
// changed since a revision. Reads only. The v1 routes (frozen snapshots) are untouched; these live beside them.
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { changes, changeSets } from "../db/schema";
import { listLabels } from "../projects/service";
import { NotFound } from "../spec/errors";
import { compareKeys } from "../spec/keys";
import { loadSpec, revisionOf } from "../spec/store";
import type { Link, Part } from "../spec/types";
import { contextIn, type PartContext } from "./context";
import { locateIn, type Candidate } from "./locate";

export const MAX_CHANGE_SETS = 500;

export type LatestLabel = { version: number; label: string | null; labelledAt: string; by: string };
type Head = { revision: number; savedAt: string | null; latestLabel: LatestLabel | null };

// The state a v2 read describes. The revision is read BEFORE the spec, so a save landing in between can only make the
// parts newer than the revision, never older: CAW then re-reads on its next poll, and never misses a change.
async function readSpec(db: Db, projectId: string): Promise<Head & { parts: Part[]; links: Link[] }> {
  const revision = await revisionOf(db, projectId); // 404 for an unknown project comes from loadSpec just below
  const spec = await loadSpec(db, projectId);
  const [savedAt, labels] = await Promise.all([savedAtOf(db, projectId, revision), listLabels(db, projectId)]);
  return { revision, savedAt, latestLabel: labels.labels[0] ?? null, ...spec };
}

async function savedAtOf(db: Db, projectId: string, revision: number): Promise<string | null> {
  if (revision === 0) return null;
  const [row] = await db.select({ at: changeSets.at }).from(changeSets).where(and(eq(changeSets.projectId, projectId), eq(changeSets.rev, revision)));
  return row?.at.toISOString() ?? null;
}

export type CurrentSpec = { projectId: string } & Head & { parts: Part[]; links: Link[] };

/** `GET …/spec` — the current spec in one read. */
export async function currentSpec(db: Db, projectId: string): Promise<CurrentSpec> {
  const s = await readSpec(db, projectId);
  return { projectId, revision: s.revision, savedAt: s.savedAt, latestLabel: s.latestLabel, parts: s.parts, links: s.links };
}

export type SpecContext = Omit<PartContext, "version" | "confirmedAt"> & Head;

/** `GET …/spec/parts/{key}/context` — the same body as the versioned context, from the current spec. */
export async function specContext(db: Db, projectId: string, key: string): Promise<SpecContext> {
  const s = await readSpec(db, projectId);
  const body = contextIn(s, key);
  if (!body) throw new NotFound(`part ${key}`);
  return { projectId, revision: s.revision, savedAt: s.savedAt, latestLabel: s.latestLabel, ...body };
}

/** `POST …/spec/locate` — matched against the current spec; never refuses for "no version". */
export async function specLocate(db: Db, projectId: string, request: string): Promise<{ revision: number; notInSpec: boolean; candidates: Candidate[] }> {
  const s = await readSpec(db, projectId);
  return { revision: s.revision, ...locateIn(s, request) };
}

export type SpecChange = {
  rev: number; at: string; by: string | null; cause: "operator" | "message" | "source" | "undo";
  added: string[]; changed: string[]; removed: string[];
};
export type SpecChanges = { revision: number; latestLabel: LatestLabel | null; changes: SpecChange[]; more: boolean };

type PartForm = { removed?: boolean } | null;
type LinkForm = { fromKey: string; toKey: string } | null;

/** `GET …/spec/changes?after=` — one entry per change set with `rev > after`, ascending, at most 500 (then `more`). */
export async function specChanges(db: Db, projectId: string, after: number): Promise<SpecChanges> {
  const revision = await revisionOf(db, projectId);
  await loadSpec(db, projectId); // 404 for an unknown project (revisionOf alone would answer 0)
  const labels = await listLabels(db, projectId);
  const sets = await db.select().from(changeSets)
    .where(and(eq(changeSets.projectId, projectId), gt(changeSets.rev, after)))
    .orderBy(asc(changeSets.rev)).limit(MAX_CHANGE_SETS + 1);
  const more = sets.length > MAX_CHANGE_SETS;
  const page = sets.slice(0, MAX_CHANGE_SETS);
  const rows = page.length === 0 ? [] : await db.select().from(changes)
    .where(inArray(changes.changeSetId, page.map((s) => s.id))).orderBy(asc(changes.changeSetId), asc(changes.seq));

  const out: SpecChange[] = page.map((cs) => {
    // The same rules the v1 feed uses (`seam/feed.ts`): a part with no `before`, or restored → added; now removed → removed;
    // any other part row → changed; a link row marks both of its end parts changed, unless that end was added/removed here.
    const added = new Set<string>(), removed = new Set<string>(), changed = new Set<string>(), ends = new Set<string>();
    for (const r of rows.filter((x) => x.changeSetId === cs.id)) {
      if (r.entity.startsWith("part:")) {
        const key = r.entity.slice(5), before = r.before as PartForm, after_ = r.after as PartForm;
        if (before === null || (before.removed && !after_?.removed)) added.add(key);
        else if (after_?.removed && !before.removed) removed.add(key);
        else changed.add(key);
      } else {
        for (const side of [r.before as LinkForm, r.after as LinkForm]) if (side) { ends.add(side.fromKey); ends.add(side.toKey); }
      }
    }
    for (const key of [...added]) if (removed.has(key)) { added.delete(key); removed.delete(key); } // made and removed inside one set
    for (const key of ends) changed.add(key);
    for (const key of [...added, ...removed]) changed.delete(key);
    const sorted = (s: Set<string>) => [...s].sort(compareKeys);
    return { rev: cs.rev, at: cs.at.toISOString(), by: cs.by, cause: cs.causeKind as SpecChange["cause"],
      added: sorted(added), changed: sorted(changed), removed: sorted(removed) };
  });
  return { revision, latestLabel: labels.labels[0] ?? null, changes: out, more };
}
