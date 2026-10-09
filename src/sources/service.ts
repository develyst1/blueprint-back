// Sources: DB rows + the add flow (SPEC-A-003 § Data Model, § Extraction). The client only ever sees the final status.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { projects, sources } from "../db/schema";
import { NotFound, ValidationError } from "../spec/errors";
import { Origin } from "../spec/types";
import { extract } from "./extract";
import { fetchLink, type LinkDeps } from "./link";
import { saveOriginal, sha256Of, storedAsOf } from "./store";

export class AlreadyAdded extends Error {
  constructor(public readonly sourceId: string) { super("this file is already a source of the project"); this.name = "AlreadyAdded"; }
}
export class UnsupportedFile extends Error {
  constructor() { super("this kind of file is not supported"); this.name = "UnsupportedFile"; }
}
export class LinkRefused extends Error {
  constructor(why: string) { super(why); this.name = "LinkRefused"; }
}

export type Source = {
  id: string; kind: "file" | "link"; name: string; mime: string | null; sha256: string; size: number;
  status: "read" | "failed"; reason?: string; note?: string; origin: Origin; createdAt: string; text?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = typeof sources.$inferSelect;

// A failed source has no text (""); a read source must have some (possibly "", e.g. an image) — null there is a fault.
function textOf(r: Row): string {
  if (r.text === null && r.status === "read") throw new Error(`integrity: source ${r.id} is read but has no text`);
  return r.text ?? "";
}

const toSource = (r: Row, withText: boolean): Source => ({
  id: r.id, kind: r.kind as Source["kind"], name: r.name, mime: r.mime, sha256: r.sha256, size: r.size,
  status: r.status as Source["status"],
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.note ? { note: r.note } : {}),
  origin: r.origin as Origin, createdAt: r.createdAt.toISOString(),
  ...(withText ? { text: textOf(r) } : {}),
});

async function requireProject(db: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  if ((await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length === 0) {
    throw new NotFound("project");
  }
}

// Who a source is from. A source's own origin cannot point at a source.
function sourceOrigin(raw: unknown): Origin {
  const parsed = Origin.safeParse(raw);
  if (!parsed.success) throw new ValidationError(null, `origin: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.sourceId !== undefined) throw new ValidationError(null, "origin: a source's origin cannot name a source");
  return parsed.data;
}

async function existing(db: Db, projectId: string, sha256: string): Promise<string | undefined> {
  const [row] = await db.select({ id: sources.id }).from(sources)
    .where(and(eq(sources.projectId, projectId), eq(sources.sha256, sha256)));
  return row?.id;
}

type Outcome = { status: "read"; text: string; note?: string } | { status: "failed"; reason: string };

// pending → original stored → extracted → read/failed, in one transaction, so `pending` is never seen outside.
async function addRow(db: Db, dir: string, projectId: string, row: {
  kind: "file" | "link"; name: string; mime: string | null; bytes: Uint8Array; origin: Origin; outcome: () => Promise<Outcome>;
}): Promise<Source> {
  const sha256 = sha256Of(row.bytes);
  const already = await existing(db, projectId, sha256);
  if (already) throw new AlreadyAdded(already);
  try {
    return await db.transaction(async (tx) => {
      const [pending] = await tx.insert(sources).values({
        projectId, kind: row.kind, name: row.name, mime: row.mime, sha256, size: row.bytes.byteLength,
        storedAs: storedAsOf(sha256), status: "pending", origin: row.origin,
      }).returning();
      await saveOriginal(dir, row.bytes);
      const o = await row.outcome();
      const [done] = await tx.update(sources).set(o.status === "read"
        ? { status: "read", text: o.text, note: o.note ?? null }
        : { status: "failed", reason: o.reason }).where(eq(sources.id, pending!.id)).returning();
      return toSource(done!, false);
    });
  } catch (e) {
    // Two adds of the same file at once: the unique constraint decides; the loser gets the winner's id.
    const err = e as { code?: string; cause?: { code?: string } };
    const code = err.cause?.code ?? err.code;
    const winner = code === "23505" ? await existing(db, projectId, sha256) : undefined;
    if (winner) throw new AlreadyAdded(winner);
    throw e;
  }
}

export async function addFile(db: Db, dir: string, projectId: string,
  input: { name: string; bytes: Uint8Array; origin: unknown }): Promise<Source> {
  await requireProject(db, projectId);
  const origin = sourceOrigin(input.origin);
  const extracted = await extract(input.bytes, input.name);
  if (extracted.status === "unsupported") throw new UnsupportedFile();
  return addRow(db, dir, projectId, {
    kind: "file", name: input.name, mime: extracted.mime, bytes: input.bytes, origin,
    outcome: async () => extracted.status === "read"
      ? { status: "read", text: extracted.text, note: extracted.note }
      : { status: "failed", reason: extracted.reason },
  });
}

export async function addLink(db: Db, dir: string, projectId: string,
  input: { link: string; origin: unknown }, deps?: LinkDeps): Promise<Source> {
  await requireProject(db, projectId);
  const origin = sourceOrigin(input.origin);
  const r = await fetchLink(input.link, deps);
  if (r.kind === "refused") throw new LinkRefused(r.why);
  // No complete body (unreachable, too large) → the original kept is the link's own text.
  const bytes = r.bytes ?? new TextEncoder().encode(r.name);
  const outcome: Outcome = r.outcome.status === "read"
    ? { status: "read", text: r.outcome.text, note: r.outcome.note }
    : { status: "failed", reason: r.outcome.reason };

  // The same link again (matched by its final URL): `read` → a duplicate; `failed` → retry into that row (TASK-A-016 Q1).
  const [before] = await db.select().from(sources)
    .where(and(eq(sources.projectId, projectId), eq(sources.kind, "link"), eq(sources.name, r.name)));
  if (before && before.status === "read") throw new AlreadyAdded(before.id);
  if (before) return retryLink(db, dir, projectId, before, { mime: r.mime, bytes, outcome });

  return addRow(db, dir, projectId, { kind: "link", name: r.name, mime: r.mime, bytes, origin, outcome: async () => outcome });
}

// Re-fetch of a failed link: update that row. If the new body is already another source of the project → 409 with
// that id, and the failed row stays exactly as it was.
async function retryLink(db: Db, dir: string, projectId: string, row: Row,
  next: { mime: string | null; bytes: Uint8Array; outcome: Outcome }): Promise<Source> {
  const sha256 = sha256Of(next.bytes);
  const owner = await existing(db, projectId, sha256);
  if (owner && owner !== row.id) throw new AlreadyAdded(owner);
  try {
    return await db.transaction(async (tx) => {
      await saveOriginal(dir, next.bytes);
      const o = next.outcome;
      const [done] = await tx.update(sources).set({
        mime: next.mime, sha256, size: next.bytes.byteLength, storedAs: storedAsOf(sha256),
        ...(o.status === "read"
          ? { status: "read", text: o.text, note: o.note ?? null, reason: null }
          : { status: "failed", reason: o.reason, text: null, note: null }),
      }).where(eq(sources.id, row.id)).returning();
      return toSource(done!, false);
    });
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    const winner = (err.cause?.code ?? err.code) === "23505" ? await existing(db, projectId, sha256) : undefined;
    if (winner) throw new AlreadyAdded(winner);
    throw e;
  }
}

export async function listSources(db: Db, projectId: string): Promise<Source[]> {
  await requireProject(db, projectId);
  const rows = await db.select().from(sources).where(eq(sources.projectId, projectId)).orderBy(asc(sources.createdAt));
  return rows.map((r) => toSource(r, false));
}

export async function getSource(db: Db, projectId: string, sourceId: string): Promise<Source> {
  await requireProject(db, projectId);
  if (!UUID_RE.test(sourceId)) throw new NotFound("source");
  const [row] = await db.select().from(sources).where(and(eq(sources.projectId, projectId), eq(sources.id, sourceId)));
  if (!row) throw new NotFound("source");
  return toSource(row, true);
}
