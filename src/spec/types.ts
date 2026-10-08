import "@hono/zod-openapi"; // extends zod with .openapi() before any schema below is built
import { z } from "zod";
import { LINK_KIND_NAMES, PART_KIND_NAMES } from "./registry";

// Shapes from SPEC-A-001 § "API / Interface Design". Field casing is the contract.

export const Stamp = z.enum([
  "operator", "operator-delegated", "team-proposed", "customer-asked", "customer-validated",
]);

export const Origin = z.object({
  stamp: Stamp,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  channel: z.string().optional(),
  note: z.string().optional(),
}).superRefine((o, ctx) => {
  if (o.stamp === "customer-validated" && !o.channel) {
    ctx.addIssue({ code: "custom", path: ["channel"], message: "customer-validated needs a channel" });
  }
  if (o.stamp === "operator-delegated" && !o.note) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "operator-delegated needs a note" });
  }
});
export type Origin = z.infer<typeof Origin>;

export const PartKindSchema = z.enum(PART_KIND_NAMES);
export const LinkKindSchema = z.enum(LINK_KIND_NAMES);

export const Part = z.object({
  key: z.string(),
  kind: PartKindSchema,
  title: z.string(),
  body: z.record(z.string(), z.unknown()),
  origin: Origin,
  createdIn: z.string(),
});
export type Part = z.infer<typeof Part>;

export const Link = z.object({
  id: z.string(),
  kind: LinkKindSchema,
  fromKey: z.string(),
  toKey: z.string(),
  position: z.number().int().min(1).max(2147483647).nullable(),
  label: z.string().nullable(),
  origin: Origin,
});
export type Link = z.infer<typeof Link>;

export const Change = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("part.add"),
    ref: z.string().regex(/^\$[A-Za-z0-9_]+$/),
    kind: PartKindSchema,
    title: z.string(),
    body: z.record(z.string(), z.unknown()),
    origin: Origin,
  }),
  z.object({
    op: z.literal("part.update"),
    key: z.string(),
    title: z.string().optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    origin: Origin.optional(),
  }),
  z.object({ op: z.literal("part.remove"), key: z.string() }),
  z.object({
    op: z.literal("link.add"),
    kind: LinkKindSchema,
    from: z.string(),
    to: z.string(),
    position: z.number().int().min(1).max(2147483647).optional(),
    label: z.string().optional(),
    origin: Origin,
  }),
  z.object({
    op: z.literal("link.update"),
    id: z.string(),
    position: z.number().int().min(1).max(2147483647).optional(),
    label: z.string().optional(),
  }),
  z.object({ op: z.literal("link.remove"), id: z.string() }),
]);
export type Change = z.infer<typeof Change>;

export const Cause = z.object({
  kind: z.enum(["operator", "message", "source"]),
  ref: z.string().optional(),
});
export type Cause = z.infer<typeof Cause>;

export const StuckItem = z.object({
  kind: z.enum(["open_question", "unlinked_part", "flow_break", "unconfirmed_guess", "screen_without_api"]),
  reason: z.enum(["unreachable", "dead_end", "unlabelled_branch", "no_interactions", "incomplete_interaction"]).optional(),
  key: z.string(),
  title: z.string(),
  linkId: z.string().optional(),
});
export type StuckItem = z.infer<typeof StuckItem>;

export const HistoryEntry = z.object({
  changeSetId: z.string(),
  at: z.string(),
  // `undo` appears only on change sets written by the undo route.
  cause: z.object({ kind: z.enum(["operator", "message", "source", "undo"]), ref: z.string().optional() }),
  entity: z.string(),
  op: z.enum(["add", "update", "remove", "restore", "link_add", "link_update", "link_remove"]),
  before: z.unknown(),
  after: z.unknown(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;
