import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import type { Gateway } from "../../gateway/client";
import { askQuestion, latestQuiz, markItem, startQuiz } from "../../quiz/store";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

const QuizItemSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  question: z.string(),
  status: z.enum(["answered", "failed"]),
  answer: z.string().nullable(),
  notInSpec: z.boolean(),
  parts: z.array(z.string()),
  mark: z.enum(["right", "wrong"]).nullable(),
  note: z.string().nullable(),
  questionKey: z.string().nullable(),
  createdAt: z.string(),
}).openapi("QuizItem");

const QuizSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  stale: z.boolean(),
  items: z.array(QuizItemSchema),
  right: z.number().int(),
  marked: z.number().int(),
  score: z.number().int().nullable(),
}).openapi("Quiz");

const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });
const QuizParams = ProjectParams.extend({ quizId: z.string() });
// Stamps carry the operator's calendar day (Asia/Bangkok).
const bangkokToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());

export function quizRoutes(app: OpenAPIHono, db: Db, gateway: Gateway) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/quizzes",
    request: { params: ProjectParams },
    responses: { 201: json(QuizSchema, "a new quiz — it becomes the latest"), 404: errors[404] },
  }), async (c) => c.json(await startQuiz(db, c.req.valid("param").projectId), 201));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/quizzes/latest",
    request: { params: ProjectParams },
    responses: { 200: json(QuizSchema, "the latest quiz, with its score and whether it is stale"), 404: errors[404] },
  }), async (c) => c.json(await latestQuiz(db, c.req.valid("param").projectId), 200));

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/quizzes/{quizId}/questions",
    request: {
      params: QuizParams,
      body: { ...json(z.object({ question: z.string() }), "one question, answered from the spec only"), required: true },
    },
    responses: {
      200: json(QuizItemSchema, "the item — `answered`, or `failed` when the bot could not answer (both 200)"),
      400: errors[400], 404: errors[404], 409: errors[409],
    },
  }), async (c) => {
    const { projectId, quizId } = c.req.valid("param");
    return c.json(await askQuestion(db, gateway, projectId, quizId, c.req.valid("json").question), 200);
  });

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/quizzes/{quizId}/items/{itemId}/mark",
    request: {
      params: QuizParams.extend({ itemId: z.string() }),
      body: {
        ...json(z.object({ mark: z.enum(["right", "wrong"]), note: z.string().max(2_000).optional() }),
          "right or wrong (final); a wrong answer becomes an open question in the spec"),
        required: true,
      },
    },
    responses: { 200: json(QuizItemSchema, "the marked item"), 400: errors[400], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    const { projectId, quizId, itemId } = c.req.valid("param");
    return c.json(await markItem(db, projectId, quizId, itemId, c.req.valid("json"), { today: bangkokToday() }), 200);
  });
}
