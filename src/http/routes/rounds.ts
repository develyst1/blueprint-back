import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import type { Gateway } from "../../gateway/client";
import {
  listMessages, MAX_ACCEPT, MAX_ANSWER_CHARS, MAX_ANSWERS, MAX_MESSAGE_CHARS, MAX_PARK, MAX_PARK_REASON_CHARS, runRound,
} from "../../interview/round";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

const RoundSchema = z.object({
  status: z.enum(["applied", "no_changes", "changes_rejected", "bot_could_not_answer"]),
  reply: z.string().nullable(),
  changeSetId: z.string().nullable(),
  questions: z.array(z.string()),
  contradictions: z.array(z.string()),
  failedSources: z.array(z.string()),
  messageIds: z.array(z.string()),
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
  }), async (c) => c.json(await runRound(db, gateway, c.req.valid("param").projectId, c.req.valid("json"), { today: bangkokToday() }), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/messages",
    request: {
      params: ProjectParams,
      query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    },
    responses: {
      200: { description: "the newest `limit` messages, oldest first", content: { "application/json": { schema: z.array(MessageSchema) } } },
      400: errors[400], 404: errors[404],
    },
  }), async (c) => c.json(await listMessages(db, c.req.valid("param").projectId, c.req.valid("query").limit), 200));
}
