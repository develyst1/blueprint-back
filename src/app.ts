import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "./db/client";
import { createGateway, type Gateway } from "./gateway/client";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES, MAX_UPLOAD_BYTES, notFound, onError, tooLarge, validationHook } from "./http/errors";
import { changeSetRoutes } from "./http/routes/change-sets";
import { diagramRoutes } from "./http/routes/diagrams";
import { modelRoutes } from "./http/routes/models";
import { partRoutes } from "./http/routes/parts";
import { projectRoutes } from "./http/routes/projects";
import { quizRoutes } from "./http/routes/quizzes";
import { seamRoutes } from "./http/routes/seam";
import { roundRoutes } from "./http/routes/rounds";
import { sourceRoutes } from "./http/routes/sources";
import { stuckRoutes } from "./http/routes/stuck";
import { versionRoutes } from "./http/routes/versions";

const DOCUMENT = { openapi: "3.1.0", info: { title: "Blueprint API", version: "1.0.0" } };

export function createApp(db: Db, deps: { gateway?: Gateway } = {}): OpenAPIHono {
  // Created lazily: no gateway call happens until a route needs one.
  const gateway = deps.gateway ?? createGateway();
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.get("/health", (c) => c.json({ ok: true, service: "blueprint-back" }));
  // 5 MB on every /v1 route except the sources upload, which takes one file of up to 20 MB.
  const usual = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
  const upload = bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: tooLarge });
  app.use("/v1/*", (c, next) =>
    (c.req.method === "POST" && /^\/v1\/projects\/[^/]+\/sources$/.test(c.req.path) ? upload : usual)(c, next));

  projectRoutes(app, db, gateway);
  changeSetRoutes(app, db);
  partRoutes(app, db);
  stuckRoutes(app, db);
  diagramRoutes(app, db);
  versionRoutes(app, db);
  sourceRoutes(app, db, process.env.SOURCES_DIR || "./data/sources");
  modelRoutes(app, gateway);
  roundRoutes(app, db, gateway);
  quizRoutes(app, db, gateway);
  seamRoutes(app, db);

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
