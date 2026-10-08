import { and, desc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client";
import { changeSets, organisations, projects, versions } from "../db/schema";
import { ConfirmBlocked, NotFound, NothingToConfirm, ValidationError } from "../spec/errors";
import { loadSpec } from "../spec/store";
import { computeStuck } from "../spec/stuck";
import type { Link, Part } from "../spec/types";

export type Project = { id: string; organisationId: string; name: string; createdAt: string; theme: string };
export type VersionSummary = { parts: number; links: number; partsByKind: Record<string, number> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toProject = (r: typeof projects.$inferSelect): Project =>
  ({ id: r.id, organisationId: r.organisationId, name: r.name, createdAt: r.createdAt.toISOString(), theme: r.theme });

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

export async function listProjects(db: Db): Promise<(Project & { stuckCount: number })[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  const out = [];
  for (const row of rows) {
    // Derived on every call, never stored (REQ-001 R9).
    out.push({ ...toProject(row), stuckCount: computeStuck(await loadSpec(db, row.id)).length });
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

export async function confirmVersion(db: Db, projectId: string, confirmedBy: string): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    if (!UUID_RE.test(projectId)) throw new NotFound("project");
    // Same lock as change sets: the snapshot cannot move under us, and version numbers do not collide.
    const locked = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (locked.length === 0) throw new NotFound("project");

    const spec = await loadSpec(tx, projectId);
    if (spec.parts.length === 0) throw new NothingToConfirm();
    const stuck = computeStuck(spec);
    if (stuck.length > 0) throw new ConfirmBlocked(stuck);

    const [{ last }] = await tx.select({ last: max(versions.version) }).from(versions).where(eq(versions.projectId, projectId));
    const [newest] = await tx.select({ id: changeSets.id }).from(changeSets)
      .where(eq(changeSets.projectId, projectId)).orderBy(desc(changeSets.at)).limit(1);
    const version = (last ?? 0) + 1;
    await tx.insert(versions).values({
      projectId, version, confirmedBy,
      snapshot: spec, summary: summarise(spec.parts, spec.links), lastChangeSet: newest!.id,
    });
    return { version };
  });
}

export async function getVersion(db: Db, projectId: string, version: number): Promise<{
  version: number; confirmedAt: string; confirmedBy: string; parts: Part[]; links: Link[]; summary: VersionSummary;
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
  };
}
