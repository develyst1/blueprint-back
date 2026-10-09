import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import type { Gateway } from "../../gateway/client";
import { createProject, getProject, listProjects, updateProject } from "../../projects/service";
import { Link, Part } from "../../spec/types";
import { errors } from "../errors";

export const ProjectParams = z.object({ projectId: z.string() });

export const ProjectSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  theme: z.string(),
  model: z.string(),
  creativity: z.number(),
}).openapi("Project");

export const PartSchema = Part.openapi("Part");
export const LinkSchema = Link.openapi("Link");

const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ description, content: { "application/json": { schema } } });

export function projectRoutes(app: OpenAPIHono, db: Db, gateway: Gateway) {
  app.openapi(createRoute({
    method: "post",
    path: "/v1/projects",
    request: {
      body: {
        ...json(z.object({
          name: z.string(),
          organisationId: z.string().optional(),
          theme: z.string().min(1).max(64).refine((s) => s.trim().length > 0, "theme is empty").optional(),
        }), "a new project"),
        required: true,
      },
    },
    responses: { 201: json(ProjectSchema, "created"), 400: errors[400], 404: errors[404], 413: errors[413] },
  }), async (c) => c.json(await createProject(db, c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects",
    responses: { 200: json(z.array(ProjectSchema.extend({ stuckCount: z.number().int(), partCount: z.number().int() })), "every project, newest first") },
  }), async (c) => c.json(await listProjects(db), 200));

  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}",
    request: { params: ProjectParams },
    responses: {
      200: json(z.object({ project: ProjectSchema, parts: z.array(PartSchema), links: z.array(LinkSchema) }), "the live spec"),
      404: errors[404],
    },
  }), async (c) => c.json(await getProject(db, c.req.valid("param").projectId), 200));

  app.openapi(createRoute({
    method: "patch",
    path: "/v1/projects/{projectId}",
    request: {
      params: ProjectParams,
      body: {
        ...json(z.object({
          model: z.string().optional().openapi({ description: '"tier:small|medium|flagship" or "<provider>/<model>" from GET /v1/models' }),
          creativity: z.number().min(0).max(2).optional(),
        }), "the chat model and/or creativity (temperature 0–2); at least one"),
        required: true,
      },
    },
    responses: {
      200: json(ProjectSchema, "the project as it is now"),
      400: errors[400], 404: errors[404], 503: errors[503],
    },
  }), async (c) => c.json(await updateProject(db, c.req.valid("param").projectId, c.req.valid("json"), gateway), 200));
}
