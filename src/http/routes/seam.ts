import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { Amendment, addAmendment } from "../../seam/amend";
import { partContext } from "../../seam/context";
import { locate, NoConfirmedVersion } from "../../seam/locate";
import { LINK_KIND_NAMES } from "../../spec/registry";
import { ErrorBody, errors } from "../errors";
import { PartSchema, ProjectParams } from "./projects";
import { MessageSchema } from "./rounds";

const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });
const PartRef = z.object({ key: z.string(), kind: z.string(), title: z.string() });

const PartContextSchema = z.object({
  projectId: z.string(),
  version: z.number().int(),
  confirmedAt: z.string(),
  part: PartSchema,
  neighbours: z.array(z.object({
    direction: z.enum(["out", "in"]), linkKind: z.enum(LINK_KIND_NAMES), label: z.string().nullable(),
    position: z.number().int().nullable(), part: PartRef,
  })),
  decisions: z.array(PartSchema),
  flows: z.array(z.object({
    work: z.object({ key: z.string(), title: z.string() }),
    steps: z.array(z.object({ key: z.string(), title: z.string(), position: z.number().int().nullable() })),
    at: z.array(z.string()),
  })),
  questions: z.array(PartSchema),
}).openapi("PartContext");

const LocatedSchema = z.object({
  version: z.number().int(),
  notInSpec: z.boolean(),
  candidates: z.array(z.object({
    key: z.string(), kind: z.string(), title: z.string(), score: z.number(),
    matched: z.array(z.string()), where: z.array(z.enum(["title", "body", "link label"])),
  })),
}).openapi("Located");

export function seamRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/versions/{version}/parts/{key}/context",
    request: { params: ProjectParams.extend({ version: z.coerce.number().int().min(1), key: z.string() }) },
    responses: { 200: json(PartContextSchema, "a part as frozen in a confirmed version, with its neighbours, decisions, flows and open questions"), 404: errors[404] },
  }), async (c) => {
    const { projectId, version, key } = c.req.valid("param");
    return c.json(await partContext(db, projectId, version, key), 200);
  });

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/locate",
    request: {
      params: ProjectParams,
      body: { ...json(z.object({ request: z.string().min(1).max(1_000) }), "a change request in words"), required: true },
    },
    responses: {
      200: json(LocatedSchema, "the parts of the latest confirmed version the request touches, best first — or notInSpec"),
      400: errors[400], 404: errors[404],
      409: json(ErrorBody, "no_confirmed_version"),
    },
  }), async (c) => {
    try {
      return c.json(await locate(db, c.req.valid("param").projectId, c.req.valid("json").request), 200);
    } catch (e) {
      // Mapped here, not in http/errors.ts — only this route raises it.
      if (e instanceof NoConfirmedVersion) return c.json({ error: { code: "no_confirmed_version", message: e.message } }, 409);
      throw e;
    }
  });

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/amendments",
    request: {
      params: ProjectParams,
      body: { ...json(Amendment, "a change request from a CAW worker — lands in the chat; the spec is not touched"), required: true },
    },
    responses: { 201: json(MessageSchema, "the `caw` chat message"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json(await addAmendment(db, c.req.valid("param").projectId, c.req.valid("json")), 201));
}
