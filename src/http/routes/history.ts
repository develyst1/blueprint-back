import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { projectHistory } from "../../spec/store";
import { ProjectHistoryEntry } from "../../spec/types";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

// SPEC-104 § history: every record of the project — spec changes and every other write — newest first.
export function historyRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/history",
    request: { params: ProjectParams, query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) },
    responses: {
      200: {
        description: "the newest `limit` records of the project, spec changes and other writes merged, newest first",
        content: { "application/json": { schema: z.object({ entries: z.array(ProjectHistoryEntry.openapi("ProjectHistoryEntry")) }) } },
      },
      400: errors[400], 404: errors[404],
    },
  }), async (c) => c.json({ entries: await projectHistory(db, c.req.valid("param").projectId, c.req.valid("query").limit) }, 200));
}
