import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { ValidationError } from "../../spec/errors";
import { Origin } from "../../spec/types";
import { addFile, addLink, getSource, listSources } from "../../sources/service";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

const SourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["file", "link"]),
  name: z.string(),
  mime: z.string().nullable(),
  sha256: z.string(),
  size: z.number().int(),
  status: z.enum(["read", "failed"]),
  reason: z.string().optional(),
  note: z.string().optional(),
  origin: Origin,
  createdAt: z.string(),
  text: z.string().optional(),
}).openapi("Source");

const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });

export function sourceRoutes(app: OpenAPIHono, db: Db, dir: string) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects/{projectId}/sources",
    request: {
      params: ProjectParams,
      body: {
        description: "a file (multipart: `file` + `origin` as a JSON string) or a link (JSON)",
        // Not `required`: with two content types the library would then run the JSON check on a multipart body.
        // Each validator runs only for its own content type; a body of neither type is refused in the handler.
        required: false,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.any().openapi({ type: "string", format: "binary" }),
              origin: z.string().openapi({ description: "an Origin as a JSON string" }),
            }),
          },
          "application/json": { schema: z.object({ link: z.string(), origin: Origin }) },
        },
      },
    },
    responses: {
      201: json(SourceSchema, "added — `status` says whether its text could be read"),
      400: errors[400], 404: errors[404], 409: errors[409], 413: errors[413], 415: errors[415],
    },
  }), async (c) => {
    const { projectId } = c.req.valid("param");
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new ValidationError(null, "file: a file is required");
      let origin: unknown;
      try { origin = JSON.parse(String(form.origin ?? "")); } catch { throw new ValidationError(null, "origin: not JSON"); }
      return c.json(await addFile(db, dir, projectId,
        { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), origin }), 201);
    }
    if (!type.startsWith("application/json")) {
      throw new ValidationError(null, "send a file as multipart/form-data or a link as application/json");
    }
    const body = c.req.valid("json");
    if (!("link" in body)) throw new ValidationError(null, "link: a link is required");
    return c.json(await addLink(db, dir, projectId, body), 201);
  });

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/sources",
    request: { params: ProjectParams },
    responses: { 200: json(z.array(SourceSchema.omit({ text: true })), "every source, oldest first, without text"), 404: errors[404] },
  }), async (c) => c.json(await listSources(db, c.req.valid("param").projectId), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/sources/{sourceId}",
    request: { params: ProjectParams.extend({ sourceId: z.string() }) },
    responses: { 200: json(SourceSchema, "one source with its text"), 404: errors[404] },
  }), async (c) => {
    const { projectId, sourceId } = c.req.valid("param");
    return c.json(await getSource(db, projectId, sourceId), 200);
  });
}
