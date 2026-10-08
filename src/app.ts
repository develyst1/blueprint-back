import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "./db/client";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES, notFound, onError, tooLarge, validationHook } from "./http/errors";
import { changeSetRoutes } from "./http/routes/change-sets";
import { diagramRoutes } from "./http/routes/diagrams";
import { partRoutes } from "./http/routes/parts";
import { projectRoutes } from "./http/routes/projects";
import { stuckRoutes } from "./http/routes/stuck";
import { versionRoutes } from "./http/routes/versions";

const DOCUMENT = { openapi: "3.1.0", info: { title: "Blueprint API", version: "1.0.0" } };

export function createApp(db: Db): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.get("/health", (c) => c.json({ ok: true, service: "blueprint-back" }));
  app.use("/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }));

  projectRoutes(app, db);
  changeSetRoutes(app, db);
  partRoutes(app, db);
  stuckRoutes(app, db);
  diagramRoutes(app, db);
  versionRoutes(app, db);

  // The document is generated from the route schemas above (REQ-001 R8), and lists itself.
  app.openapi(createRoute({
    method: "get",
    path: "/v1/openapi.json",
    responses: {
      200: { description: "this API's OpenAPI 3.1 document", content: { "application/json": { schema: z.looseObject({ openapi: z.string() }) } } },
    },
  }), (c) => c.json(app.getOpenAPI31Document(DOCUMENT), 200));

  app.notFound(notFound);
  app.onError(onError);
  return app;
}
