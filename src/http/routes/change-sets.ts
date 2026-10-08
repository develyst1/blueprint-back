import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { applyChangeSet, undoChangeSet } from "../../spec/store";
import { Cause, Change } from "../../spec/types";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });

export function changeSetRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/change-sets",
    request: {
      params: ProjectParams,
      body: {
        ...json(z.object({ cause: Cause.openapi("Cause"), changes: z.array(Change.openapi("Change")).max(5000) }),
          "changes applied all or nothing"),
        required: true,
      },
    },
    responses: {
      201: json(z.object({ changeSetId: z.string(), keys: z.record(z.string(), z.string()) }), "applied; temp refs → new keys"),
      400: errors[400],
      404: errors[404],
      413: errors[413],
    },
  }), async (c) => c.json(await applyChangeSet(db, c.req.valid("param").projectId, c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/change-sets/{changeSetId}/undo",
    request: { params: ProjectParams.extend({ changeSetId: z.string() }) },
    responses: {
      201: json(z.object({ changeSetId: z.string() }), "the undo, as a new change set"),
      404: errors[404],
      409: errors[409],
    },
  }), async (c) => {
    const { projectId, changeSetId } = c.req.valid("param");
    return c.json(await undoChangeSet(db, projectId, changeSetId), 201);
  });
}
