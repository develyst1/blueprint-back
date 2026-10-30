import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { Amendment, addAmendment } from "../../seam/amend";
import { partContext } from "../../seam/context";
import { locate, NoConfirmedVersion } from "../../seam/locate";
import { currentSpec, specChanges, specContext, specLocate } from "../../seam/spec";
import { LINK_KIND_NAMES } from "../../spec/registry";
import { ErrorBody, errors } from "../errors";
import { LinkSchema, PartSchema, ProjectParams } from "./projects";
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
  relatedDecisions: z.array(z.object({ via: z.string(), decision: PartSchema })),
  relatedDecisionsMore: z.boolean(),
}).openapi("PartContext");

const LocatedSchema = z.object({
  version: z.number().int(),
  notInSpec: z.boolean(),
  candidates: z.array(z.object({
    key: z.string(), kind: z.string(), title: z.string(), score: z.number(),
    matched: z.array(z.string()), where: z.array(z.enum(["title", "body", "link label"])),
  })),
}).openapi("Located");

// SPEC-106 (REQ-105) seam contract v2: the latest spec, named by a revision. Field casing is the contract Team B builds on.
const LatestLabelSchema = z.object({
  version: z.number().int(), label: z.string().nullable(), labelledAt: z.string(), by: z.string(),
}).nullable();
const SpecHead = { revision: z.number().int(), savedAt: z.string().nullable(), latestLabel: LatestLabelSchema };

const CurrentSpecSchema = z.object({
  projectId: z.string(), ...SpecHead, parts: z.array(PartSchema), links: z.array(LinkSchema),
}).openapi("CurrentSpec");

const SpecContextSchema = PartContextSchema.omit({ version: true, confirmedAt: true }).extend(SpecHead).openapi("SpecPartContext");

const SpecLocatedSchema = LocatedSchema.omit({ version: true }).extend({ revision: z.number().int() }).openapi("SpecLocated");

const SpecChangesSchema = z.object({
  revision: z.number().int(),
  latestLabel: LatestLabelSchema,
  changes: z.array(z.object({
    rev: z.number().int(), at: z.string(), by: z.string().nullable(),
    cause: z.enum(["operator", "message", "source", "undo"]),
    added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()),
  })),
  more: z.boolean(),
}).openapi("SpecChanges");

export function seamRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/spec",
    request: { params: ProjectParams },
    responses: { 200: json(CurrentSpecSchema, "the current spec in one read, with its revision and the latest label"), 404: errors[404] },
  }), async (c) => c.json(await currentSpec(db, c.req.valid("param").projectId), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/spec/parts/{key}/context",
    request: { params: ProjectParams.extend({ key: z.string() }) },
    responses: { 200: json(SpecContextSchema, "one part's context, from the current spec"), 404: errors[404] },
  }), async (c) => {
    const { projectId, key } = c.req.valid("param");
    return c.json(await specContext(db, projectId, key), 200);
  });

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/spec/locate",
    request: {
      params: ProjectParams,
      body: { ...json(z.object({ request: z.string().min(1).max(1_000) }), "a change request in words"), required: true },
    },
    responses: { 200: json(SpecLocatedSchema, "the parts of the current spec the request touches, best first — or notInSpec"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json(await specLocate(db, c.req.valid("param").projectId, c.req.valid("json").request), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/spec/changes",
    request: { params: ProjectParams, query: z.object({ after: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(SpecChangesSchema, "what changed since a revision, one entry per saved change set (first 500; `more` says there are further ones)"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json(await specChanges(db, c.req.valid("param").projectId, c.req.valid("query").after), 200));

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
