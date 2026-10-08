import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ConfirmBlocked, NothingToConfirm, NotFound, UndoConflict, ValidationError } from "../spec/errors";

// One error body everywhere (SPEC-A-001): { error: { code, message, details? } }.
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
}).openapi("Error");

const errorContent = (description: string) =>
  ({ description, content: { "application/json": { schema: ErrorBody } } });

// Error responses for route definitions, so the document shows them.
export const errors = {
  400: errorContent("validation"),
  404: errorContent("not_found"),
  409: errorContent("undo_conflict · confirm_blocked · nothing_to_confirm"),
  413: errorContent("too_large"),
} as const;

// 5 MB, decimal: the TASK's test sends 5,000,001 bytes and expects 413 (SPEC-A-001 § Non-functional).
export const MAX_BODY_BYTES = 5_000_000;

function body(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

// A change set's request errors point at the first bad change, like the store's ValidationError.
function fromZod(error: z.ZodError) {
  const path = error.issues[0]?.path ?? [];
  const index = path[0] === "changes" && typeof path[1] === "number" ? path[1] : undefined;
  return body("validation", z.prettifyError(error), index === undefined ? undefined : { index });
}

// Request validation (body, path params) → 400 in the same shape as every other error.
export function validationHook(result: { success: boolean; error?: unknown }, c: Context) {
  if (!result.success) return c.json(fromZod(result.error as z.ZodError), 400);
}

export function tooLarge(c: Context) {
  return c.json(body("too_large", `the request body is over ${MAX_BODY_BYTES} bytes`), 413);
}

// An unknown path or method answers in the same shape as every other error.
export function notFound(c: Context) {
  return c.json(body("not_found", `no route ${c.req.method} ${c.req.path}`), 404);
}

export function onError(err: Error, c: Context) {
  if (err instanceof ValidationError) {
    return c.json(body("validation", err.message, err.index === null ? undefined : { index: err.index }), 400);
  }
  if (err instanceof z.ZodError) return c.json(fromZod(err), 400);
  if (err instanceof NotFound) return c.json(body("not_found", err.message), 404);
  if (err instanceof UndoConflict) return c.json(body("undo_conflict", err.message, { parts: err.parts }), 409);
  if (err instanceof ConfirmBlocked) return c.json(body("confirm_blocked", err.message, { items: err.items }), 409);
  if (err instanceof NothingToConfirm) return c.json(body("nothing_to_confirm", err.message), 409);
  // Request faults Hono raises itself (malformed JSON, a body that is not JSON) are bad input: 400.
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(body("validation", `${err.message} — send the body as application/json`), 400);
  }
  console.error(err);
  return c.json(body("internal", "something went wrong on the server"), 500);
}
