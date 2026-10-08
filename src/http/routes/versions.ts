import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { confirmVersion, getVersion } from "../../projects/service";
import { errors } from "../errors";
import { LinkSchema, PartSchema, ProjectParams } from "./projects";

export function versionRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/versions",
    request: {
      params: ProjectParams,
      body: {
        description: "who confirms",
        required: true,
        // Non-empty after trim (TASK-A-006 Q1.3).
        content: { "application/json": { schema: z.object({ confirmedBy: z.string().trim().min(1) }) } },
      },
    },
    responses: {
      201: { description: "confirmed and frozen", content: { "application/json": { schema: z.object({ version: z.number().int() }) } } },
      400: errors[400],
      404: errors[404],
      409: errors[409],
      413: errors[413],
    },
  }), async (c) => {
    const { projectId } = c.req.valid("param");
    return c.json(await confirmVersion(db, projectId, c.req.valid("json").confirmedBy), 201);
  });

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
}
