import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import type { Gateway } from "../../gateway/client";
import {
  listMessages, MAX_ACCEPT, MAX_ANSWER_CHARS, MAX_ANSWERS, MAX_MESSAGE_CHARS, MAX_PARK, MAX_PARK_REASON_CHARS, runRound,
} from "../../interview/round";
import { byOf } from "../actor";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

// REQ-110 round 2 (SPEC-105 E6): a model item the server did not store, or — last, past 50 — how many more there were.
const RefusedItemSchema = z.union([
  z.object({
    item: z.string(), op: z.string().nullable(), kind: z.string().nullable(), ref: z.string().nullable(), key: z.string().nullable(),
    title: z.string().nullable(), reason: z.enum(["unknown_kind", "needs_user_words", "invalid_change", "depends_on_refused"]), detail: z.string(),
  }),
  z.object({ item: z.literal("more"), count: z.number().int() }),
]).openapi("RefusedItem");

// REQ-110 round 3 (SPEC-105 E8/E9): what the server changed in an item it stored, or — last, past 50 — how many more.
const AdjustedItemSchema = z.union([
  z.object({
    item: z.string(), what: z.enum(["ref_renamed", "body_defaulted", "wrapped_in_list", "field_dropped", "op_renamed"]),
    // The stored item, as a refused entry names it.
    title: z.string().nullable(), key: z.string().nullable(), ref: z.string().nullable(),
    field: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  }),
  z.object({ item: z.literal("more"), count: z.number().int() }),
]).openapi("AdjustedItem");

const RoundSchema = z.object({
  status: z.enum(["applied", "no_changes", "changes_rejected", "bot_could_not_answer"]),
  reply: z.string().nullable(),
  changeSetId: z.string().nullable(),
  questions: z.array(z.string()),
  contradictions: z.array(z.string()),
  failedSources: z.array(z.string()),
  messageIds: z.array(z.string()),
  // REQ-110: why a round was rejected (reply is then null) or why the bot could not answer; null otherwise. `note` ≤ 60 chars.
  reason: z.string().nullable(),
  note: z.string().nullable(),
  // Every model item left out of the round (reply is then null); null when nothing was.
  refused: z.array(RefusedItemSchema).nullable(),
  // How many model items the round did store, set with `refused`; null otherwise.
  saved: z.number().int().nullable(),
  // What the server adjusted in the items it stored; null when nothing.
  adjusted: z.array(AdjustedItemSchema).nullable(),
}).openapi("Round");

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "bot", "caw"]),
  content: z.string(),
  model: z.string(),
  creativity: z.number(),
  roundStatus: z.string().nullable(),
  changeSetId: z.string().nullable(),
  createdAt: z.string(),
}).openapi("Message");

// The chat list: a message plus why a failed bot row failed (REQ-110). Separate from `MessageSchema` so the seam's
// `POST …/amendments` response keeps exactly the shape it had.
const ChatMessageSchema = MessageSchema.extend({
  roundReason: z.string().nullable(),
  roundNote: z.string().nullable(),
  roundRefused: z.array(RefusedItemSchema).nullable(),
  roundSaved: z.number().int().nullable(),
  roundAdjusted: z.array(AdjustedItemSchema).nullable(),
  // The first 4000 characters of a reply the server could not read — for the team, never for the UI.
  roundRaw: z.string().nullable(),
}).openapi("ChatMessage");

// Stamps carry the operator's calendar day (Asia/Bangkok), not UTC's.
const bangkokToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());

export function roundRoutes(app: OpenAPIHono, db: Db, gateway: Gateway) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/rounds",
    request: {
      params: ProjectParams,
      body: {
        description: "one chat turn: a message, accepted question keys, answers in the user's own words, questions to park — any mix; or `retry: true` alone to ask the bot again for the newest turn that failed",
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              message: z.string().max(MAX_MESSAGE_CHARS).refine((s) => !s.includes("\u0000"), "message contains a NUL character").optional(),
              accept: z.array(z.string()).max(MAX_ACCEPT).optional(),
              // SPEC-A-003 Addendum A: answer an open question by key in the user's own words · park it ("not needed").
              answers: z.array(z.object({
                key: z.string(),
                text: z.string().min(1).max(MAX_ANSWER_CHARS).refine((s) => !s.includes("\u0000"), "text contains a NUL character"),
              })).max(MAX_ANSWERS).optional(),
              park: z.array(z.object({
                key: z.string(),
                reason: z.string().max(MAX_PARK_REASON_CHARS).refine((s) => !s.includes("\u0000"), "reason contains a NUL character").optional(),
              })).max(MAX_PARK).optional(),
              // D-023 (TASK-A-037): alone only — the server refuses it with any other field (400).
              retry: z.literal(true).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "the round — every outcome is 200, including a bot that could not answer", content: { "application/json": { schema: RoundSchema } } },
      400: errors[400], 404: errors[404], 409: errors[409],
    },
  }), async (c) => c.json(await runRound(db, gateway, c.req.valid("param").projectId, c.req.valid("json"), { today: bangkokToday(), by: byOf(c) }), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/messages",
    request: {
      params: ProjectParams,
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    },
    responses: {
      200: { description: "the newest `limit` messages, oldest first", content: { "application/json": { schema: z.array(ChatMessageSchema) } } },
      400: errors[400], 404: errors[404],
    },
  }), async (c) => c.json(await listMessages(db, c.req.valid("param").projectId, c.req.valid("query").limit), 200));
}
