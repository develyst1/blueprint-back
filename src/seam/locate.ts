// SPEC-A-005 § S1.2: where in the spec does a request belong? A deterministic Thai word match against the latest
// confirmed version — no model, no gateway call. Reads only.
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { versions } from "../db/schema";
import { compareKeys } from "../spec/keys";
import type { Link, Part } from "../spec/types";
import { requireProject } from "./feed";

export const LOCATE_THRESHOLD = 0.5;
const MAX_CANDIDATES = 10;

export class NoConfirmedVersion extends Error {
  constructor() { super("locate needs a confirmed version — confirm the spec first"); this.name = "NoConfirmedVersion"; }
}

type Where = "title" | "body" | "link label";
export type Candidate = { key: string; kind: Part["kind"]; title: string; score: number; matched: string[]; where: Where[] };

const segmenter = new Intl.Segmenter("th", { granularity: "word" });
// Word-like segments only, lower-case, at least 2 characters.
export const words = (s: string): string[] =>
  [...segmenter.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment.toLowerCase()).filter((w) => w.length >= 2);

const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

async function latest(db: Db, projectId: string) {
  await requireProject(db, projectId);
  const [row] = await db.select().from(versions).where(eq(versions.projectId, projectId)).orderBy(desc(versions.version)).limit(1);
  if (!row) throw new NoConfirmedVersion();
  return { version: row.version!, snapshot: row.snapshot as { parts: Part[]; links: Link[] } };
}

function score(request: string[], parts: Part[], links: Link[]): Candidate[] {
  if (request.length === 0) return [];
  return parts.map((p) => {
    const fields: [Where, Set<string>][] = [
      ["title", new Set(words(p.title))],
      ["body", new Set(strings(p.body).flatMap(words))],
      ["link label", new Set(links.filter((l) => l.label && (l.fromKey === p.key || l.toKey === p.key)).flatMap((l) => words(l.label!)))],
    ];
    const matched = request.filter((w) => fields.some(([, ws]) => ws.has(w)));
    const where = fields.filter(([, ws]) => matched.some((w) => ws.has(w))).map(([name]) => name);
    return { key: p.key, kind: p.kind, title: p.title, score: Math.round((matched.length / request.length) * 100) / 100, matched, where };
  }).sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || compareKeys(a.key, b.key));
}

// Every part scored, best first — for the tests' sub-threshold report; `locate` is the API.
export async function scoreAll(db: Db, projectId: string, request: string): Promise<Candidate[]> {
  const { snapshot } = await latest(db, projectId);
  return score([...new Set(words(request))], snapshot.parts, snapshot.links);
}

export async function locate(db: Db, projectId: string, request: string):
  Promise<{ version: number; notInSpec: boolean; candidates: Candidate[] }> {
  const { version, snapshot } = await latest(db, projectId);
  const candidates = score([...new Set(words(request))], snapshot.parts, snapshot.links)
    .filter((c) => c.score >= LOCATE_THRESHOLD).slice(0, MAX_CANDIDATES);
  return { version, notInSpec: candidates.length === 0, candidates };
}
