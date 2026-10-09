import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { GatewayUnavailable } from "../gateway/client";
import { NothingToRetry } from "../interview/round";
import { AlreadyAdded, LinkRefused, UnsupportedFile } from "../sources/service";
import {
  AlreadyConfirmed, AlreadyMarked, ConfirmBlocked, NothingToConfirm, NotFound, NotMarkable, QuizClosed, QuizFull, QuizMissing, QuizNot100,
  QuizStale, UndoConflict, ValidationError,
} from "../spec/errors";

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
  409: errorContent("undo_conflict · confirm_blocked · nothing_to_confirm · already_confirmed · already_added · quiz_missing · quiz_not_100 · quiz_stale · quiz_closed · quiz_full · already_marked · not_markable · nothing_to_retry"),
  413: errorContent("too_large"),
  415: errorContent("unsupported_file"),
  503: errorContent("gateway_unavailable"),
} as const;

// The sources upload route allows one file of up to 20 MB (SPEC-A-003); every other route keeps 5 MB.
export const MAX_UPLOAD_BYTES = 20_000_000;

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
  return c.json(body("too_large", "the request body is too large"), 413);
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
  if (err instanceof AlreadyConfirmed) return c.json(body("already_confirmed", err.message, { version: err.version }), 409);
  if (err instanceof QuizMissing) return c.json(body("quiz_missing", err.message), 409);
  if (err instanceof QuizNot100) return c.json(body("quiz_not_100", err.message, { right: err.right, marked: err.marked }), 409);
  if (err instanceof QuizStale) return c.json(body("quiz_stale", err.message), 409);
  if (err instanceof QuizClosed) return c.json(body("quiz_closed", err.message), 409);
  if (err instanceof QuizFull) return c.json(body("quiz_full", err.message), 409);
  if (err instanceof AlreadyMarked) return c.json(body("already_marked", err.message), 409);
  if (err instanceof NotMarkable) return c.json(body("not_markable", err.message), 409);
  if (err instanceof NothingToRetry) return c.json(body("nothing_to_retry", err.message), 409);
  if (err instanceof AlreadyAdded) return c.json(body("already_added", err.message, { sourceId: err.sourceId }), 409);
  if (err instanceof UnsupportedFile) return c.json(body("unsupported_file", err.message), 415);
  if (err instanceof LinkRefused) return c.json(body("link_refused", err.message), 400);
  if (err instanceof GatewayUnavailable) return c.json(body("gateway_unavailable", err.message, { reason: err.reason }), 503);
  // Request faults Hono raises itself (malformed JSON, a body that is not JSON) are bad input: 400.
  if (err instanceof HTTPException && err.status < 500) {
    // Name JSON only when the request said it was JSON (TASK-A-016 Q5); a broken upload gets a neutral hint.
    const json = (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
    return c.json(body("validation", json
      ? `${err.message} — send the body as application/json`
      : `${err.message} — the request body could not be read`), 400);
  }
  // Name and code only: a database error's message and params can hold spec or document text (SPEC-A-003 Q4).
  const code = (err as { cause?: { code?: string } }).cause?.code;
  console.error(`[http] 500 ${err.name}${code ? ` code=${code}` : ""}`);
  return c.json(body("internal", "something went wrong on the server"), 500);
}
