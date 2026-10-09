// SPEC-A-005 § S1.3: the change feed — confirmed versions after `n`, each with the keys that changed since the version
// before it. `changes` is computed from the frozen snapshots on every read, never stored (harness §9). Reads only.
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, versions } from "../db/schema";
import { newestChangeSet, type VersionSummary } from "../projects/service";
import { NotFound } from "../spec/errors";
import { compareKeys } from "../spec/keys";
import type { Link, Part } from "../spec/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireProject(db: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  if ((await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length === 0) throw new NotFound("project");
}

type Snapshot = { parts: Part[]; links: Link[] };
export type Changes = { added: string[]; changed: string[]; removed: string[] };
export type FeedEntry = { version: number; confirmedAt: string; confirmedBy: string; summary: VersionSummary; changes: Changes };

// Keys compared between two snapshots. "Changed" = title, body or origin differs; a link added, removed or edited
// counts as `changed` on both of its ends (unless that end was itself added or removed).
export function diff(before: Snapshot, after: Snapshot): Changes {
  const was = new Map(before.parts.map((p) => [p.key, p]));
  const now = new Map(after.parts.map((p) => [p.key, p]));
  const added = [...now.keys()].filter((k) => !was.has(k));
  const removed = [...was.keys()].filter((k) => !now.has(k));
  const changed = new Set([...now.keys()].filter((k) => {
    const a = was.get(k), b = now.get(k)!;
    return a && !Bun.deepEquals([a.title, a.body, a.origin], [b.title, b.body, b.origin]);
  }));
  const linkForm = (l: Link) => [l.kind, l.fromKey, l.toKey, l.position, l.label, l.origin];
  const linksBefore = new Map(before.links.map((l) => [l.id, l]));
  const linksAfter = new Map(after.links.map((l) => [l.id, l]));
  for (const id of new Set([...linksBefore.keys(), ...linksAfter.keys()])) {
    const a = linksBefore.get(id), b = linksAfter.get(id);
    if (a && b && Bun.deepEquals(linkForm(a), linkForm(b))) continue;
    for (const end of [a?.fromKey, a?.toKey, b?.fromKey, b?.toKey]) if (end && was.has(end) && now.has(end)) changed.add(end);
  }
  return { added: added.sort(compareKeys), changed: [...changed].sort(compareKeys), removed: removed.sort(compareKeys) };
}

export type VersionFeed = {
  versions: FeedEntry[];
  latest: { version: number; confirmedAt: string } | null; // the newest confirmed version, whatever `after` is
  changedSinceLatest: boolean; // the spec moved after the latest confirm (no version → false)
};

export async function versionFeed(db: Db, projectId: string, after: number): Promise<VersionFeed> {
  await requireProject(db, projectId);
  // Version `after` itself is read too: it is the base of the first entry's `changes` (none before v1 → empty).
  const rows = await db.select().from(versions)
    .where(and(eq(versions.projectId, projectId), gte(versions.version, after)))
    .orderBy(asc(versions.version));
  let previous: Snapshot = { parts: [], links: [] };
  const out: FeedEntry[] = [];
  for (const row of rows) {
    const snapshot = row.snapshot as Snapshot;
    if (row.version! > after) {
      out.push({ version: row.version!, confirmedAt: row.confirmedAt.toISOString(), confirmedBy: row.confirmedBy,
        summary: row.summary as VersionSummary, changes: diff(previous, snapshot) });
    }
    previous = snapshot;
  }
  // TASK-A-032: compared by change-set id, never by clock — any change set after the confirm (an edit, an undo, a quiz
  // wrong mark) means the spec is no longer the confirmed one.
  const [newest] = await db.select({ version: versions.version, confirmedAt: versions.confirmedAt, lastChangeSet: versions.lastChangeSet })
    .from(versions).where(eq(versions.projectId, projectId)).orderBy(desc(versions.version)).limit(1);
  const latest = newest ? { version: newest.version!, confirmedAt: newest.confirmedAt.toISOString() } : null;
  const changedSinceLatest = !!newest && (await newestChangeSet(db, projectId)) !== newest.lastChangeSet;
  return { versions: out, latest, changedSinceLatest };
}
