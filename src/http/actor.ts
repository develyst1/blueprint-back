import type { Context, Next } from "hono";

// SPEC-104 D4 (REQ-103): every write names who made it, in `X-Blueprint-By` (percent-encoded: a Thai name is not a
// valid raw header value). One middleware covers every write route, the multipart upload included.
export const BY_HEADER = "x-blueprint-by";
export const MAX_NAME_CHARS = 100;

export class NameRequired extends Error {
  constructor() { super("type your name first"); this.name = "NameRequired"; }
}

// The seam's two writes keep working with no name: `locate` is a read, and CAW names itself in an amendment's `from`.
const SEAM_WRITES = /^\/v1\/projects\/[^/]+\/(locate|amendments)$/;
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// The decoded, trimmed name, or null when the header is missing, not decodable, empty, too long or holds a NUL.
export function parseName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let name: string;
  try { name = decodeURIComponent(raw).trim(); } catch { return null; }
  if (name.length < 1 || name.length > MAX_NAME_CHARS || name.includes("\u0000")) return null;
  return name;
}

export async function actor(c: Context, next: Next) {
  if (WRITE_METHODS.has(c.req.method) && !SEAM_WRITES.test(c.req.path)) {
    const name = parseName(c.req.header(BY_HEADER));
    if (name === null) throw new NameRequired(); // before any handler runs: nothing is written
    c.set("by", name);
  }
  await next();
}

// The name the middleware stored. A write route calls this; reaching it without a name is our bug, not the caller's.
export function byOf(c: Context): string {
  const name = c.get("by") as string | undefined;
  if (!name) throw new Error("integrity: a write route ran with no actor name");
  return name;
}
