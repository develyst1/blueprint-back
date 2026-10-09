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
};

export async function partContext(db: Db, projectId: string, version: number, key: string): Promise<PartContext> {
  const v = await getVersion(db, projectId, version); // 404 for an unknown project or a version never confirmed
  const byKey = new Map(v.parts.map((p) => [p.key, p]));
  const part = byKey.get(key);
  if (!part) throw new NotFound(`part ${key} in version ${version}`);
  const links = v.links;
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

  return { projectId, version: v.version, confirmedAt: v.confirmedAt, part, neighbours, decisions, flows, questions };
}
