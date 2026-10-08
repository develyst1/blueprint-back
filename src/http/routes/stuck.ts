import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { loadSpec } from "../../spec/store";
import { computeStuck } from "../../spec/stuck";
import { StuckItem } from "../../spec/types";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

export const StuckItemSchema = StuckItem.openapi("StuckItem");

export function stuckRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/stuck",
    request: { params: ProjectParams },
    responses: {
      200: {
        description: "what is stuck, computed on this read",
        content: { "application/json": { schema: z.object({ items: z.array(StuckItemSchema) }) } },
      },
      404: errors[404],
    },
  }), async (c) => c.json({ items: computeStuck(await loadSpec(db, c.req.valid("param").projectId)) }, 200));
}
