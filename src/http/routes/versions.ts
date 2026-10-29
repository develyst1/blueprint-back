import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { confirmVersion, getVersion, listLabels, MAX_LABEL_CHARS } from "../../projects/service";
import { versionFeed } from "../../seam/feed";
import { byOf } from "../actor";
import { errors } from "../errors";
import { LinkSchema, PartSchema, ProjectParams } from "./projects";

export function versionRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/versions",
    request: {
      params: ProjectParams,
      body: {
        description: "the label to put on the spec as it is now; who puts it is the `X-Blueprint-By` header",
        required: true,
        // REQ-103 / SPEC-104 D2: no gate. Typed text, trimmed, 1–80 characters — an empty one is a 400 and saves nothing.
        content: { "application/json": { schema: z.object({ label: z.string().trim().min(1).max(MAX_LABEL_CHARS) }) } },
      },
    },
    responses: {
      201: { description: "labelled and frozen", content: { "application/json": { schema: z.object({ version: z.number().int(), label: z.string() }) } } },
      400: errors[400],
      404: errors[404],
      413: errors[413],
    },
  }), async (c) => {
    const { projectId } = c.req.valid("param");
    const { label } = c.req.valid("json");
    const { version } = await confirmVersion(db, projectId, byOf(c), label);
    return c.json({ version, label }, 201);
  });

  // SPEC-104 § labels: the list a person sees. The seam routes below are not changed by it (no `label` field on them).
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/labels",
    request: { params: ProjectParams },
    responses: {
      200: {
        description: "every label of the project, newest first; `label` is null on a version confirmed before labels existed",
        content: {
          "application/json": {
            schema: z.object({
              labels: z.array(z.object({ version: z.number().int(), label: z.string().nullable(), labelledAt: z.string(), by: z.string() })),
            }).openapi("Labels"),
          },
        },
      },
      404: errors[404],
    },
  }), async (c) => c.json(await listLabels(db, c.req.valid("param").projectId), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/versions/{version}",
    request: { params: ProjectParams.extend({ version: z.coerce.number().int().min(1) }) },
    responses: {
      200: {
        description: "a confirmed version, read from its frozen row",
        content: {
          "application/json": {
            schema: z.object({
              version: z.number().int(),
              confirmedAt: z.string(),
              confirmedBy: z.string(),
              parts: z.array(PartSchema),
              links: z.array(LinkSchema),
              summary: z.object({ parts: z.number().int(), links: z.number().int(), partsByKind: z.record(z.string(), z.number().int()) }),
              // REQ-005: the quiz that passed the confirm gate, frozen; null for versions confirmed before it.
              quiz: z.object({
                id: z.string(),
                createdAt: z.string(),
                items: z.array(z.object({
                  position: z.number().int(), question: z.string(), status: z.enum(["answered", "failed"]),
                  answer: z.string().nullable(), notInSpec: z.boolean(), parts: z.array(z.string()),
                  mark: z.enum(["right", "wrong"]).nullable(), note: z.string().nullable(),
                })),
                right: z.number().int(), marked: z.number().int(), score: z.number().int().nullable(),
              }).nullable().openapi("FrozenQuiz"),
            }).openapi("Version"),
          },
        },
      },
      404: errors[404],
    },
  }), async (c) => {
    const { projectId, version } = c.req.valid("param");
    return c.json(await getVersion(db, projectId, version), 200);
  });

  // SPEC-A-005 § S1.3: the change feed for AI workers — `changes` is computed from the snapshots on read.
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/versions",
    request: { params: ProjectParams, query: z.object({ after: z.coerce.number().int().min(0).default(0) }) },
    responses: {
      200: {
        description: "confirmed versions after `after`, ascending, each with the keys added, changed and removed since the one before",
        content: {
          "application/json": {
            schema: z.object({
              versions: z.array(z.object({
                version: z.number().int(),
                confirmedAt: z.string(),
                confirmedBy: z.string(),
                summary: z.object({ parts: z.number().int(), links: z.number().int(), partsByKind: z.record(z.string(), z.number().int()) }),
                changes: z.object({ added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()) }),
              })),
              // TASK-A-032: the newest confirmed version (null = none), and whether the spec changed after it.
              latest: z.object({ version: z.number().int(), confirmedAt: z.string() }).nullable(),
              changedSinceLatest: z.boolean(),
            }).openapi("VersionFeed"),
          },
        },
      },
      400: errors[400],
      404: errors[404],
    },
  }), async (c) => {
    const { projectId } = c.req.valid("param");
    return c.json(await versionFeed(db, projectId, c.req.valid("query").after), 200);
  });
}
