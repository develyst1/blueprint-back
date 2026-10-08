import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { flowchart, sequence, swimlane } from "../../spec/diagrams";
import { loadSpec } from "../../spec/store";
import { PartKindSchema } from "../../spec/types";
import { errors } from "../errors";
import { ProjectParams } from "./projects";

const Participant = z.object({ key: z.string(), kind: PartKindSchema, title: z.string() });

const Sequence = z.object({
  participants: z.array(Participant),
  messages: z.array(z.object({
    key: z.string(), from: z.string().nullable(), to: z.string().nullable(), text: z.string(), reply: z.string().nullable(),
  })),
}).openapi("SequenceDiagram");

const Swimlane = z.object({
  lanes: z.array(Participant),
  rows: z.array(z.object({
    step: z.object({ key: z.string(), title: z.string(), position: z.number().int().nullable() }),
    lanes: z.array(z.string()),
  })),
}).openapi("SwimlaneDiagram");

const Flowchart = z.object({
  nodes: z.array(z.object({
    key: z.string(), title: z.string(), position: z.number().int().nullable(), ends: z.boolean(), isBranch: z.boolean(),
  })),
  arrows: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().nullable() })),
}).openapi("FlowchartDiagram");

export function diagramRoutes(app: OpenAPIHono, db: Db) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/projects/{projectId}/diagrams/{kind}/{key}",
    request: {
      // sequence takes a step key; swimlane and flowchart take a work key.
      params: ProjectParams.extend({ kind: z.enum(["sequence", "swimlane", "flowchart"]), key: z.string() }),
    },
    responses: {
      200: {
        description: "drawing data, projected from parts and links on this read",
        content: { "application/json": { schema: z.union([Sequence, Swimlane, Flowchart]) } },
      },
      400: errors[400],
      404: errors[404],
    },
  }), async (c) => {
    const { projectId, kind, key } = c.req.valid("param");
    const spec = await loadSpec(db, projectId);
    const draw = { sequence, swimlane, flowchart }[kind];
    return c.json(draw(spec, key), 200);
  });
}
