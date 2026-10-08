import { compareKeys } from "./keys";
import type { Link, Part, StuckItem } from "./types";

// "What is stuck" (SPEC-A-001, REQ-001 R5) — computed from the live spec on every read, never stored.

const KIND_ORDER: StuckItem["kind"][] = [
  "open_question", "unlinked_part", "flow_break", "unconfirmed_guess", "screen_without_api",
];
const REASON_ORDER: NonNullable<StuckItem["reason"]>[] = [
  "unreachable", "dead_end", "unlabelled_branch", "no_interactions", "incomplete_interaction",
];

type Spec = { parts: Part[]; links: Link[] };

const byPosition = (a: Link, b: Link) => (a.position ?? Infinity) - (b.position ?? Infinity);

function flowBreaks(spec: Spec, partByKey: Map<string, Part>): StuckItem[] {
  const out: StuckItem[] = [];
  const nextFrom = (key: string) => spec.links.filter((l) => l.kind === "next" && l.fromKey === key);
  for (const work of spec.parts.filter((p) => p.kind === "work")) {
    const steps = spec.links.filter((l) => l.kind === "has_step" && l.fromKey === work.key).sort(byPosition)
      .map((l) => partByKey.get(l.toKey)!);
    if (steps.length === 0) continue;

    // Breadth-first from step 01 along `next`.
    const reached = new Set([steps[0]!.key]);
    const queue = [steps[0]!.key];
    while (queue.length) {
      for (const l of nextFrom(queue.shift()!)) {
        if (!reached.has(l.toKey)) { reached.add(l.toKey); queue.push(l.toKey); }
      }
    }

    for (const step of steps) {
      const out1 = (reason: StuckItem["reason"]) => out.push({ kind: "flow_break", reason, key: step.key, title: step.title });
      const next = nextFrom(step.key);
      if (!reached.has(step.key)) out1("unreachable");
      if (next.length === 0 && step.body.ends !== true) out1("dead_end");
      if (next.length >= 2 && next.some((l) => !l.label?.trim())) out1("unlabelled_branch");
      const interactions = spec.links.filter((l) => l.kind === "has_interaction" && l.fromKey === step.key);
      if (interactions.length === 0) out1("no_interactions");
      // One item per step, however many of its interactions lack a `from` or a `to` end.
      const hasEnd = (int: string, side: "from" | "to") => spec.links.some((l) => l.kind === side && l.fromKey === int);
      if (interactions.some((l) => !hasEnd(l.toKey, "from") || !hasEnd(l.toKey, "to"))) out1("incomplete_interaction");
    }
  }
  return out;
}

function screensWithoutApi(spec: Spec, partByKey: Map<string, Part>): StuckItem[] {
  const ends = (interaction: string) => spec.links
    .filter((l) => (l.kind === "from" || l.kind === "to") && l.fromKey === interaction).map((l) => l.toKey);
  const interactions = spec.parts.filter((p) => p.kind === "interaction").map((p) => ends(p.key));
  return spec.parts
    .filter((p) => p.kind === "screen" && spec.links.some((l) => l.kind === "shows" && l.fromKey === p.key))
    .filter((screen) => !interactions.some((e) =>
      e.includes(screen.key) && e.some((k) => k !== screen.key && partByKey.get(k)?.kind === "api")))
    .map((screen) => ({ kind: "screen_without_api" as const, key: screen.key, title: screen.title }));
}

export function computeStuck(spec: Spec): StuckItem[] {
  const partByKey = new Map(spec.parts.map((p) => [p.key, p]));
  const linked = new Set(spec.links.flatMap((l) => [l.fromKey, l.toKey]));
  const items: StuckItem[] = [
    ...spec.parts.filter((p) => p.kind === "question" && p.body.status === "open")
      .map((p) => ({ kind: "open_question" as const, key: p.key, title: p.title })),
    ...spec.parts.filter((p) => p.kind !== "question" && !linked.has(p.key))
      .map((p) => ({ kind: "unlinked_part" as const, key: p.key, title: p.title })),
    ...flowBreaks(spec, partByKey),
    ...spec.parts.filter((p) => p.origin.stamp === "team-proposed")
      .map((p) => ({ kind: "unconfirmed_guess" as const, key: p.key, title: p.title })),
    ...spec.links.filter((l) => l.origin.stamp === "team-proposed")
      .map((l) => ({ kind: "unconfirmed_guess" as const, key: l.fromKey, title: partByKey.get(l.fromKey)!.title, linkId: l.id })),
    ...screensWithoutApi(spec, partByKey),
  ];

  // A step in two works would be listed twice — keep one.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const id = `${i.kind}|${i.key}|${i.reason ?? ""}|${i.linkId ?? ""}`;
    return seen.has(id) ? false : (seen.add(id), true);
  });
  const rank = (r: StuckItem["reason"]) => (r ? REASON_ORDER.indexOf(r) : -1);
  return unique.sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || compareKeys(a.key, b.key)
    || rank(a.reason) - rank(b.reason)
    || (a.linkId ?? "").localeCompare(b.linkId ?? ""));
}
