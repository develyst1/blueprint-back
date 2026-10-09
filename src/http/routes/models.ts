import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { GatewayUnavailable, type Gateway } from "../../gateway/client";
import { errors } from "../errors";

export function modelRoutes(app: OpenAPIHono, gateway: Gateway) {
  app.openapi(createRoute({
    method: "get",
    path: "/v1/models",
    responses: {
      200: {
        description: "the models the gateway offers right now (read live on every call), and the tiers",
        content: {
          "application/json": {
            schema: z.object({
              models: z.record(z.string(), z.array(z.string())),
              tiers: z.array(z.enum(["small", "medium", "flagship"])),
            }).openapi("Models"),
          },
        },
      },
      503: errors[503],
    },
  }), async (c) => {
    const r = await gateway.listModels();
    if (!r.ok) throw new GatewayUnavailable(r.reason);
    return c.json({ models: r.models, tiers: r.tiers }, 200);
  });
}
