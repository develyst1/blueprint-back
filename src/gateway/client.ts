// The one place that talks to the LLM Gateway (SPEC-A-003 § Gateway client). Every failure is a failure — an empty
// answer is never treated as an answer. Request and response bodies are never logged (they can hold documents).

export type GatewayFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Tier = "small" | "medium" | "flagship";
export const TIERS: Tier[] = ["small", "medium", "flagship"];

export type FailReason = "network" | "timeout" | `http_${number}` | "not_json" | "not_success" | "empty_content" | "too_large";

// A gateway answer larger than this is refused (SPEC-A-003 § Provenance guard, rule 6).
export const MAX_RESPONSE_BYTES = 1_000_000;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult =
  | { ok: true; content: string; provider: string; model: string; usage: unknown }
  | { ok: false; reason: FailReason };
export type ModelsResult =
  | { ok: true; models: Record<string, string[]>; tiers: Tier[] }
  | { ok: false; reason: FailReason };

export type Gateway = {
  listModels(): Promise<ModelsResult>;
  chat(request: { model: string; creativity: number; messages: ChatMessage[] }): Promise<ChatResult>;
};

// The gateway could not be reached or answered wrongly; the HTTP layer answers 503 gateway_unavailable.
export class GatewayUnavailable extends Error {
  constructor(public readonly reason: FailReason) { super("the model gateway is not available"); this.name = "GatewayUnavailable"; }
}

const MAX_TOKENS = 4000; // well above the empty-content trap seen with max_tokens 40 (SYSTEM-FACTS)

// `"tier:<t>"` → { tier } (the gateway picks the provider) · `"<provider>/<model>"` → { provider, model }.
export function modelRequest(model: string): { tier: Tier } | { provider: string; model: string } {
  if (model.startsWith("tier:")) {
    const tier = model.slice(5) as Tier;
    if (TIERS.includes(tier)) return { tier };
  } else {
    const slash = model.indexOf("/");
    if (slash > 0 && slash < model.length - 1) return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  }
  throw new Error(`not a model id: "${model}"`); // the PATCH validates first; reaching here is a bug
}

type Got = { ok: true; json: unknown } | { ok: false; reason: FailReason };

// The whole body, or null as soon as it passes `max` bytes (the rest is not read).
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? NaN) > max) { await res.body?.cancel(); return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// `retry` (default on): a failed chat is tried once more (R8). The live smoke turns it off — one POST /chat per run
// is the decided budget (DECISIONS 2026-10-09).
export function createGateway(
  options: { baseUrl?: string; fetch?: GatewayFetch; timeoutMs?: number; retry?: boolean } = {},
): Gateway {
  const base = (options.baseUrl || process.env.GATEWAY_URL || "https://ai.develyst.online").replace(/\/$/, "");
  const doFetch: GatewayFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 90_000;
  const retry = options.retry ?? true;

  // One request, whole body read, inside the timeout. Never throws.
  async function call(path: string, init?: RequestInit): Promise<Got> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true }));
    let res: Response;
    let text: string;
    try {
      res = await Promise.race([doFetch(`${base}${path}`, { ...init, signal }), timedOut]);
      const body = await Promise.race([readCapped(res, MAX_RESPONSE_BYTES), timedOut]);
      if (body === null) return { ok: false, reason: "too_large" };
      text = new TextDecoder("utf-8").decode(body);
    } catch (e) {
      return { ok: false, reason: (e as { name?: string })?.name === "TimeoutError" ? "timeout" : "network" };
    }
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, reason: "not_json" }; }
  }

  async function chatOnce(body: unknown): Promise<ChatResult> {
    const got = await call("/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!got.ok) return got;
    const r = got.json as { success?: unknown; data?: { content?: unknown; provider?: unknown; model?: unknown; usage?: unknown } };
    if (r?.success !== true) return { ok: false, reason: "not_success" };
    const content = r.data?.content;
    if (typeof content !== "string" || content.trim() === "") return { ok: false, reason: "empty_content" };
    return { ok: true, content, provider: String(r.data?.provider ?? ""), model: String(r.data?.model ?? ""), usage: r.data?.usage ?? null };
  }

  return {
    // Only GET /models is an allowed live read; the tiers are the three the gateway's POST /chat contract names.
    async listModels() {
      const m = await call("/models");
      if (!m.ok) return m;
      const models = m.json as Record<string, unknown>;
      const isList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
      if (!models || typeof models !== "object" || !Object.values(models).every(isList)) return { ok: false, reason: "not_json" };
      return { ok: true, models: models as Record<string, string[]>, tiers: [...TIERS] };
    },
    async chat({ model, creativity, messages }) {
      const body = { ...modelRequest(model), temperature: creativity, max_tokens: MAX_TOKENS, messages };
      const first = await chatOnce(body);
      return first.ok || !retry ? first : chatOnce(body); // retry once, then the second answer stands (R8)
    },
  };
}
