import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { partHistory } from "../../spec/store";
import { HistoryEntry } from "../../spec/types";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

export function partRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/parts/{key}/history",
    request: { params: ProjectParams.extend({ key: z.string() }) },
    responses: {
      200: {
        description: "every change to the part and to links touching it, oldest first",
        content: { "application/json": { schema: z.array(HistoryEntry.openapi("HistoryEntry")) } },
      },
      404: errors[404],
    },
  }), async (c) => {
    const { projectId, key } = c.req.valid("param");
    return c.json(await partHistory(db, projectId, key), 200);
  });
}
