// SPEC-A-005 § S1.1: everything an AI worker needs about one part, read from a confirmed version's frozen snapshot —
// never the live draft. Reads only.
import type { Db } from "../db/client";
import { getVersion } from "../projects/service";
import { compareKeys } from "../spec/keys";
import { NotFound } from "../spec/errors";
import type { Link, Part } from "../spec/types";

export type Neighbour = {
  direction: "out" | "in"; linkKind: Link["kind"]; label: string | null; position: number | null;
  part: { key: string; kind: Part["kind"]; title: string };
};
export type Flow = { work: { key: string; title: string }; steps: { key: string; title: string; position: number | null }[]; at: string[] };
export type PartContext = {
  projectId: string; version: number; confirmedAt: string; part: Part;
  neighbours: Neighbour[]; decisions: Part[]; flows: Flow[]; questions: Part[];
  relatedDecisions: RelatedDecision[]; relatedDecisionsMore: boolean;
  requirements: Part[]; // SPEC-115 / REQ-118: every requirement of the spec, by key — the same for every part
};
// SPEC-106 § REQ-112: a decision that covers a step the part sits in, or a work of its flows, and is not one of `decisions`.
export type RelatedDecision = { via: string; decision: Part };
export const MAX_RELATED_DECISIONS = 50;

export async function partContext(db: Db, projectId: string, version: number, key: string): Promise<PartContext> {
  const v = await getVersion(db, projectId, version); // 404 for an unknown project or a version never confirmed
  const body = contextIn({ parts: v.parts, links: v.links }, key);
  if (!body) throw new NotFound(`part ${key} in version ${version}`);
  return { projectId, version: v.version, confirmedAt: v.confirmedAt, ...body };
}

// The part's context from any `{ parts, links }` — a frozen snapshot (v1 above) or the live spec (SPEC-106, `seam/spec.ts`).
// null when `key` is not one of the parts.
export function contextIn(spec: { parts: Part[]; links: Link[] }, key: string): Omit<PartContext, "projectId" | "version" | "confirmedAt"> | null {
  const byKey = new Map(spec.parts.map((p) => [p.key, p]));
  const part = byKey.get(key);
  if (!part) return null;
  const links = spec.links;
  const from = (kind: Link["kind"], fromKey: string) => links.filter((l) => l.kind === kind && l.fromKey === fromKey).map((l) => l.toKey);
  const to = (kind: Link["kind"], toKey: string) => links.filter((l) => l.kind === kind && l.toKey === toKey).map((l) => l.fromKey);

  const neighbours: Neighbour[] = links.filter((l) => l.fromKey === key || l.toKey === key).map((l) => {
    const out = l.fromKey === key;
    const other = byKey.get(out ? l.toKey : l.fromKey)!;
    return { direction: out ? "out" : "in", linkKind: l.kind, label: l.label, position: l.position,
      part: { key: other.key, kind: other.kind, title: other.title } };
  });
  const decisions = to("covers", key).map((k) => byKey.get(k)!).filter((p) => p.kind === "decision");
  // Every question about this part, any status, as frozen — an open one cannot exist in a confirmed version (it blocks
  // confirm), so the answered ones are the useful context (SPEC-A-005 § S1.1, changed 2026-10-09).
  const questions = to("about", key).map((k) => byKey.get(k)!).filter((p) => p.kind === "question");

  // The climb (SPEC-A-005 § S1.1 "Flows"): the steps a part sits in, and works named directly.
  const stepsOfInteractions = (ints: string[]) => ints.flatMap((i) => to("has_interaction", i));
  const participantSteps = (k: string) => stepsOfInteractions([...to("from", k), ...to("to", k)]);
  function climb(k: string, hop: boolean): { steps: string[]; works: string[] } {
    const p = byKey.get(k)!;
    switch (p.kind) {
      case "step": return { steps: [k], works: [] };
      case "work": return { steps: [], works: [k] };
      case "interaction": return { steps: to("has_interaction", k), works: [] };
      case "role": case "screen": case "api": case "system": return { steps: participantSteps(k), works: [] };
      case "data": return { steps: [
        ...stepsOfInteractions(to("carries", k)),
        ...[...to("shows", k), ...to("reads", k), ...to("writes", k)].flatMap(participantSteps),
      ], works: [] };
      default: { // decision · question · contradiction: one hop through what they cover / are about / conflict with
        if (!hop) return { steps: [], works: [] };
        const targets = [...from("covers", k), ...from("about", k), ...from("conflicts", k)].map((t) => climb(t, false));
        return { steps: targets.flatMap((t) => t.steps), works: targets.flatMap((t) => t.works) };
      }
    }
  }
  const { steps: mine, works: named } = climb(key, true);
  const here = new Set(mine);
  const workKeys = new Set([...named, ...mine.flatMap((s) => to("has_step", s))]);
  const flows: Flow[] = [...workKeys].sort(compareKeys).map((w) => {
    // `links` is already ordered by position, so each work's steps come out in has_step order.
    const steps = links.filter((l) => l.kind === "has_step" && l.fromKey === w)
      .map((l) => ({ key: l.toKey, title: byKey.get(l.toKey)!.title, position: l.position }));
    return { work: { key: w, title: byKey.get(w)!.title }, steps, at: steps.filter((s) => here.has(s.key)).map((s) => s.key) };
  });

  // Decisions that cover what the part's flows touch (`at` steps, the works, and — E17 — every step of a work the climb named
  // directly, whose `at` is empty), minus the part's own `decisions` and the part itself; once per decision, `via` = the lowest
  // key it covers among those; by decision key, capped.
  const own = new Set([key, ...decisions.map((d) => d.key)]);
  const namedSteps = flows.filter((f) => named.includes(f.work.key)).flatMap((f) => f.steps.map((s) => s.key));
  const touched = [...new Set([...flows.flatMap((f) => [f.work.key, ...f.at]), ...namedSteps])].sort(compareKeys);
  const via = new Map<string, string>();
  for (const t of touched) for (const d of to("covers", t)) if (!own.has(d) && byKey.get(d)?.kind === "decision" && !via.has(d)) via.set(d, t);
  const related = [...via.keys()].sort(compareKeys).map((d) => ({ via: via.get(d)!, decision: byKey.get(d)! }));

  // SPEC-115 / REQ-118: a requirement stands alone (no link), so it reaches a card by being listed on every context.
  const requirements = spec.parts.filter((p) => p.kind === "requirement").sort((a, b) => compareKeys(a.key, b.key));

  return { part, neighbours, decisions, flows, questions,
    relatedDecisions: related.slice(0, MAX_RELATED_DECISIONS), relatedDecisionsMore: related.length > MAX_RELATED_DECISIONS, requirements };
}
