import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { GatewayUnavailable, TIERS, type Gateway, type Tier } from "../gateway/client";
import { changeSets, organisations, projects, versions } from "../db/schema";
import { freeze, latestQuizOrNull } from "../quiz/store";
import { notifyConfirmed } from "../seam/notify";
import {
  AlreadyConfirmed, ConfirmBlocked, NotFound, NothingToConfirm, QuizMissing, QuizNot100, QuizStale, ValidationError,
} from "../spec/errors";
import { loadSpec, type Tx } from "../spec/store";
import { computeStuck } from "../spec/stuck";
import type { Link, Part } from "../spec/types";

export type Project = {
  id: string; organisationId: string; name: string; createdAt: string; theme: string; model: string; creativity: number;
};
export type VersionSummary = { parts: number; links: number; partsByKind: Record<string, number> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toProject = (r: typeof projects.$inferSelect): Project =>
  ({
    id: r.id, organisationId: r.organisationId, name: r.name, createdAt: r.createdAt.toISOString(), theme: r.theme,
    model: r.model, creativity: r.creativity,
  });

async function projectRow(db: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) throw new NotFound("project");
  return row;
}

export async function createProject(
  db: Db,
  input: { name: string; organisationId?: string; theme?: string },
): Promise<Project> {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError(null, "a project needs a name");
  // Same rule as the API, so a direct caller cannot store what the route would refuse. Kept as given otherwise.
  if (input.theme !== undefined && (input.theme.trim().length === 0 || input.theme.length > 64)) {
    throw new ValidationError(null, "a theme id is 1–64 characters and not only spaces");
  }
  if (input.organisationId !== undefined) {
    const found = UUID_RE.test(input.organisationId)
      && (await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, input.organisationId))).length > 0;
    if (!found) throw new NotFound("organisation");
  }
  const [row] = await db.insert(projects)
    .values({
      name,
      ...(input.organisationId !== undefined ? { organisationId: input.organisationId } : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
    })
    .returning();
  return toProject(row!);
}

export async function listProjects(db: Db): Promise<(Project & { stuckCount: number; partCount: number })[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  const out = [];
  for (const row of rows) {
    // Derived on every call from one spec read, never stored (REQ-001 R9) · partCount = live parts (D-025, TASK-A-041).
    const spec = await loadSpec(db, row.id);
    out.push({ ...toProject(row), stuckCount: computeStuck(spec).length, partCount: spec.parts.length });
  }
  return out;
}

export async function getProject(db: Db, projectId: string): Promise<{ project: Project; parts: Part[]; links: Link[] }> {
  const row = await projectRow(db, projectId);
  return { project: toProject(row), ...(await loadSpec(db, projectId)) };
}

function summarise(parts: Part[], links: Link[]): VersionSummary {
  const partsByKind: Record<string, number> = {};
  for (const p of parts) partsByKind[p.kind] = (partsByKind[p.kind] ?? 0) + 1;
  return { parts: parts.length, links: links.length, partsByKind };
}

// The project's newest change set — what a confirm freezes as `lastChangeSet`, and what the feed compares it with
// (TASK-A-032). One query for both, so "changed since the latest version" can never disagree with the confirm.
export async function newestChangeSet(q: Db | Tx, projectId: string): Promise<string | null> {
  const [newest] = await q.select({ id: changeSets.id }).from(changeSets)
    .where(eq(changeSets.projectId, projectId)).orderBy(desc(changeSets.at)).limit(1);
  return newest?.id ?? null;
}

export async function confirmVersion(db: Db, projectId: string, confirmedBy: string): Promise<{ version: number }> {
  const confirmed = await db.transaction(async (tx) => {
    if (!UUID_RE.test(projectId)) throw new NotFound("project");
    // Same lock as change sets: the snapshot cannot move under us, and version numbers do not collide.
    const locked = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (locked.length === 0) throw new NotFound("project");

    const spec = await loadSpec(tx, projectId);
    if (spec.parts.length === 0) throw new NothingToConfirm();
    // D-030: nothing changed since the newest version (same shared "newest change set" as the feed) → refused here,
    // before the stuck and quiz checks; nothing is written.
    const newest = await newestChangeSet(tx, projectId);
    const [latest] = await tx.select({ version: versions.version, lastChangeSet: versions.lastChangeSet }).from(versions)
      .where(eq(versions.projectId, projectId)).orderBy(desc(versions.version)).limit(1);
    if (latest && latest.lastChangeSet === newest) throw new AlreadyConfirmed(latest.version!);
    const stuck = computeStuck(spec);
    if (stuck.length > 0) throw new ConfirmBlocked(stuck);
    // REQ-005 rule 8, in this order: a quiz exists · ≥ 5 marked, all right · no spec change since it started.
    const quiz = await latestQuizOrNull(tx, projectId);
    if (!quiz) throw new QuizMissing();
    if (quiz.marked < 5 || quiz.right < quiz.marked) throw new QuizNot100(quiz.right, quiz.marked);
    if (quiz.stale) throw new QuizStale();

    const version = (latest?.version ?? 0) + 1;
    const [row] = await tx.insert(versions).values({
      projectId, version, confirmedBy,
      snapshot: spec, summary: summarise(spec.parts, spec.links), lastChangeSet: newest!,
      quiz: freeze(quiz), // rule 9: the quiz that passed, frozen in the same INSERT
    }).returning({ confirmedAt: versions.confirmedAt });
    return { version, confirmedAt: row!.confirmedAt.toISOString() };
  });
  // SPEC-A-005 § S2.5: after the commit, never inside it; failure is logged, never raised.
  await notifyConfirmed({ projectId, ...confirmed });
  return { version: confirmed.version };
}

export async function getVersion(db: Db, projectId: string, version: number): Promise<{
  version: number; confirmedAt: string; confirmedBy: string; parts: Part[]; links: Link[]; summary: VersionSummary;
  quiz: ReturnType<typeof freeze> | null;
}> {
  await projectRow(db, projectId);
  const [row] = Number.isInteger(version)
    ? await db.select().from(versions).where(and(eq(versions.projectId, projectId), eq(versions.version, version)))
    : [];
  if (!row) throw new NotFound(`version ${version}`);
  // Read from the frozen row only — never from the live tables.
  const snapshot = row.snapshot as { parts: Part[]; links: Link[] };
  return {
    version: row.version!, confirmedAt: row.confirmedAt.toISOString(), confirmedBy: row.confirmedBy,
    parts: snapshot.parts, links: snapshot.links, summary: row.summary as VersionSummary,
    quiz: (row.quiz as ReturnType<typeof freeze> | null) ?? null, // null for versions confirmed before REQ-005
  };
}

// Change the project's model and/or creativity (REQ-003 R3). Touches only the project row — never the spec (AC-9).
// A tier is checked here; a "<provider>/<model>" must be in the gateway's live list (down → GatewayUnavailable).
export async function updateProject(db: Db, projectId: string, patch: { model?: string; creativity?: number },
  gateway: Gateway): Promise<Project> {
  await projectRow(db, projectId);
  if (patch.model === undefined && patch.creativity === undefined) throw new ValidationError(null, "give a model or a creativity");
  if (patch.creativity !== undefined && !(patch.creativity >= 0 && patch.creativity <= 2)) {
    throw new ValidationError(null, "creativity is a number from 0 to 2");
  }
  if (patch.model !== undefined) {
    if (patch.model.startsWith("tier:")) {
      if (!TIERS.includes(patch.model.slice(5) as Tier)) throw new ValidationError(null, `unknown tier "${patch.model}"`);
    } else {
      const slash = patch.model.indexOf("/");
      const list = await gateway.listModels();
      if (!list.ok) throw new GatewayUnavailable(list.reason);
      const known = slash > 0 && (list.models[patch.model.slice(0, slash)] ?? []).includes(patch.model.slice(slash + 1));
      if (!known) throw new ValidationError(null, `"${patch.model}" is not a model the gateway offers`);
    }
  }
  const [row] = await db.update(projects).set({
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.creativity !== undefined ? { creativity: patch.creativity } : {}),
  }).where(eq(projects.id, projectId)).returning();
  return toProject(row!);
}
