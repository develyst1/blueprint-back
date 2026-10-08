import { NotFound, ValidationError } from "./errors";
import type { PartKind } from "./registry";
import type { Link, Part } from "./types";

// Diagrams are read-time projections of parts and links — nothing is stored per diagram (SPEC-A-001).

type Spec = { parts: Part[]; links: Link[] };
type Participant = { key: string; kind: PartKind; title: string };

export type SequenceDiagram = {
  participants: Participant[];
  messages: { key: string; from: string | null; to: string | null; text: string; reply: string | null }[];
};
export type SwimlaneDiagram = {
  lanes: Participant[];
  rows: { step: { key: string; title: string; position: number | null }; lanes: string[] }[];
};
export type FlowchartDiagram = {
  nodes: { key: string; title: string; position: number | null; ends: boolean; isBranch: boolean }[];
  arrows: { from: string; to: string; label: string | null }[];
};

const byPosition = (a: Link, b: Link) => (a.position ?? Infinity) - (b.position ?? Infinity);

function partOf(spec: Spec, key: string, kind: PartKind): Part {
  const part = spec.parts.find((p) => p.key === key);
  if (!part) throw new NotFound(`part ${key}`);
  if (part.kind !== kind) throw new ValidationError(null, `${key} is a ${part.kind}, not a ${kind}`);
  return part;
}

const outgoing = (spec: Spec, kind: Link["kind"], fromKey: string) =>
  spec.links.filter((l) => l.kind === kind && l.fromKey === fromKey).sort(byPosition);

const endOf = (spec: Spec, interaction: string, side: "from" | "to") =>
  spec.links.find((l) => l.kind === side && l.fromKey === interaction)?.toKey ?? null;

// The step's interactions in order, each with its two ends.
function exchanges(spec: Spec, stepKey: string) {
  return outgoing(spec, "has_interaction", stepKey).map((l) => {
    const int = spec.parts.find((p) => p.key === l.toKey)!;
    return { int, from: endOf(spec, int.key, "from"), to: endOf(spec, int.key, "to") };
  });
}

// Participants in order of first appearance, `from` before `to`.
function participantKeys(rows: { from: string | null; to: string | null }[], into: string[] = []): string[] {
  for (const r of rows) for (const k of [r.from, r.to]) if (k && !into.includes(k)) into.push(k);
  return into;
}

function participant(spec: Spec, key: string): Participant {
  const p = spec.parts.find((x) => x.key === key)!;
  return { key: p.key, kind: p.kind, title: p.title };
}

export function sequence(spec: Spec, stepKey: string): SequenceDiagram {
  partOf(spec, stepKey, "step");
  const rows = exchanges(spec, stepKey);
  return {
    participants: participantKeys(rows).map((k) => participant(spec, k)),
    messages: rows.map(({ int, from, to }) => ({
      key: int.key, from, to, text: String(int.body.text ?? ""), reply: (int.body.reply as string | undefined) ?? null,
    })),
  };
}

export function swimlane(spec: Spec, workKey: string): SwimlaneDiagram {
  partOf(spec, workKey, "work");
  const all: string[] = [];
  const rows = outgoing(spec, "has_step", workKey).map((l) => {
    const step = spec.parts.find((p) => p.key === l.toKey)!;
    const ex = exchanges(spec, step.key);
    participantKeys(ex, all);
    return { step: { key: step.key, title: step.title, position: l.position }, lanes: participantKeys(ex) };
  });
  return { lanes: all.map((k) => participant(spec, k)), rows };
}

export function flowchart(spec: Spec, workKey: string): FlowchartDiagram {
  partOf(spec, workKey, "work");
  const stepLinks = outgoing(spec, "has_step", workKey);
  const inWork = new Set(stepLinks.map((l) => l.toKey));
  return {
    nodes: stepLinks.map((l) => {
      const step = spec.parts.find((p) => p.key === l.toKey)!;
      return { key: step.key, title: step.title, position: l.position, ends: step.body.ends === true,
        isBranch: outgoing(spec, "next", step.key).length >= 2 };
    }),
    // Ordered by the from-step's position in the work, then the link's own position.
    arrows: stepLinks.flatMap((l) => outgoing(spec, "next", l.toKey))
      .filter((n) => inWork.has(n.toKey))
      .map((n) => ({ from: n.fromKey, to: n.toKey, label: n.label })),
  };
}
