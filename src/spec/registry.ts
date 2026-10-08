import { z } from "zod";

// The one place that says which kinds of part and link exist. A new kind is an entry here,
// never a table change (REQ-001 R2). Every body is strict: an unknown field is an error.
export const PART_KINDS = {
  work: { prefix: "WRK", body: z.strictObject({ goal: z.string().optional() }) },
  step: { prefix: "STEP", body: z.strictObject({ ends: z.boolean().default(false) }) },
  interaction: {
    prefix: "INT",
    body: z.strictObject({ text: z.string().min(1), reply: z.string().optional() }),
  },
  role: { prefix: "ROLE", body: z.strictObject({}) },
  screen: {
    prefix: "SCR",
    body: z.strictObject({
      fields: z.array(z.strictObject({ name: z.string(), label: z.string().optional(), type: z.string().optional() }))
        .default([]),
      actions: z.array(z.strictObject({ name: z.string(), label: z.string().optional() })).default([]),
      states: z.array(z.strictObject({ name: z.string(), note: z.string().optional() })).default([]),
    }),
  },
  api: {
    prefix: "API",
    body: z.strictObject({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().startsWith("/"),
      request: z.unknown().optional(),
      responses: z.array(z.strictObject({
        status: z.number().int().min(100).max(599),
        body: z.unknown().optional(),
        note: z.string().optional(),
      })).default([]),
    }),
  },
  system: { prefix: "SYS", body: z.strictObject({}) },
  data: {
    prefix: "DATA",
    body: z.strictObject({
      fields: z.array(z.strictObject({ name: z.string(), type: z.string().optional(), note: z.string().optional() }))
        .default([]),
    }),
  },
  decision: {
    prefix: "DEC",
    body: z.strictObject({
      rule: z.string().min(1),
      cases: z.array(z.string()).default([]),
      neighbouring: z.string().optional(),
      open: z.string().optional(),
    }),
  },
  question: {
    prefix: "Q",
    body: z.strictObject({
      text: z.string().min(1),
      proposedAnswer: z.string().optional(),
      status: z.enum(["open", "answered", "parked"]).default("open"),
      answer: z.string().optional(),
    }),
  },
} as const;

export type PartKind = keyof typeof PART_KINDS;
export const PART_KIND_NAMES = Object.keys(PART_KINDS) as [PartKind, ...PartKind[]];

type LinkRule = {
  from: readonly PartKind[] | "any";
  to: readonly PartKind[] | "any";
  ordered: boolean;
  labelled: boolean;
};

const PARTICIPANTS = ["role", "screen", "api", "system"] as const;

export const LINK_KINDS = {
  has_step: { from: ["work"], to: ["step"], ordered: true, labelled: false },
  next: { from: ["step"], to: ["step"], ordered: true, labelled: true },
  has_interaction: { from: ["step"], to: ["interaction"], ordered: true, labelled: false },
  from: { from: ["interaction"], to: PARTICIPANTS, ordered: false, labelled: false },
  to: { from: ["interaction"], to: PARTICIPANTS, ordered: false, labelled: false },
  carries: { from: ["interaction"], to: ["data"], ordered: false, labelled: false },
  reads: { from: ["api"], to: ["data"], ordered: false, labelled: false },
  writes: { from: ["api"], to: ["data"], ordered: false, labelled: false },
  shows: { from: ["screen"], to: ["data"], ordered: false, labelled: false },
  covers: { from: ["decision"], to: "any", ordered: false, labelled: false },
  about: { from: ["question"], to: "any", ordered: false, labelled: false },
} as const satisfies Record<string, LinkRule>;

export type LinkKind = keyof typeof LINK_KINDS;
export const LINK_KIND_NAMES = Object.keys(LINK_KINDS) as [LinkKind, ...LinkKind[]];

function allows(side: readonly PartKind[] | "any", kind: string): boolean {
  return side === "any" || (side as readonly string[]).includes(kind);
}

// Why a link would be invalid under the registry, or null when it is allowed.
export function checkLink(link: {
  kind: string;
  fromKind: string;
  toKind: string;
  position?: number | null;
  label?: string | null;
}): string | null {
  const rule: LinkRule | undefined = (LINK_KINDS as Record<string, LinkRule>)[link.kind];
  if (!rule) return `unknown link kind "${link.kind}"`;
  if (!allows(rule.from, link.fromKind)) return `a ${link.kind} link cannot start at a ${link.fromKind}`;
  if (!allows(rule.to, link.toKind)) return `a ${link.kind} link cannot end at a ${link.toKind}`;
  if (!rule.ordered && link.position != null) return `a ${link.kind} link has no position`;
  if (!rule.labelled && link.label != null) return `a ${link.kind} link has no label`;
  return null;
}
