// Fetching a link as a source (SPEC-A-003 § Extraction, link row), with the SSRF guard.
// Known gap, accepted for v1 (single user, SPEC-A-003 § Risks): DNS can answer differently between our check and
// the fetch (rebinding). Every redirect target is re-checked the same way.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extract, tooLong } from "./extract";

export const LINK_MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

export type LinkDeps = {
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};
const defaults: LinkDeps = {
  lookup: (host) => dnsLookup(host, { all: true }),
  fetch: (url, init) => fetch(url, init),
};

export type LinkOutcome =
  | { status: "read"; text: string; note?: "charset_unknown" }
  | { status: "failed"; reason: "link_unreachable" | "link_too_large" | "link_unsupported" | "unreadable_pdf" | "extract_error" | "text_too_large" };
export type LinkResult =
  | { kind: "refused"; why: string }
  // `bytes` is null when no complete body was fetched (unreachable, too large).
  | { kind: "fetched"; name: string; mime: string | null; bytes: Uint8Array | null; outcome: LinkOutcome };

function ipv4Parts(a: string): number[] | null {
  const p = a.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
    // Not private, but never a public web server (TASK-A-016 Q3): benchmark 198.18/15, multicast 224/4,
    // reserved 240/4 (with broadcast 255.255.255.255).
    || (a === 198 && (b === 18 || b === 19)) || a! >= 224;
}

// Eight 16-bit groups, with "::" and an embedded IPv4 tail expanded.
function ipv6Groups(a: string): number[] | null {
  let s = a.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = ipv4Parts(v4[1]!);
    if (!p) return null;
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const parse = (x: string | undefined) => (x ? x.split(":").map((h) => parseInt(h, 16)) : []);
  const h = parse(head), t = parse(tail);
  const groups = s.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const v4 = ipv4Parts(a);
  if (v4) return privateV4(v4);
  const g = ipv6Groups(a);
  if (!g) return true; // not an address we understand: refuse
  if (g.every((x) => x === 0)) return true;                              // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;   // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true;                          // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true;                          // fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return true;                          // fec0::/10 (old site-local)
  if ((g[0]! & 0xff00) === 0xff00) return true;                          // ff00::/8 multicast
  // IPv4 carried inside IPv6 is checked as that IPv4: mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96,
  // 6to4 2002::/16 (its IPv4 sits in groups 1–2).
  const tail = () => [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(tail());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(tail());
  if (g[0] === 0x2002) return privateV4([g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff]);
  return false;
}

// null = allowed · "unresolvable" = our own lookup failed (never fetch then: the fetch would resolve on its own,
// unchecked) · any other string = refused, and why.
async function refusal(url: URL, deps: LinkDeps): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https links";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = (await deps.lookup(host)).map((r) => r.address); } catch { return "unresolvable"; }
  }
  return addresses.some(isPrivateAddress) ? "the link points at a private or local address" : null;
}

// An unknown charset label is read as UTF-8 and says so (TASK-A-016 Q4).
const decode = (bytes: Uint8Array, charset: string | undefined): { text: string; unknown: boolean } => {
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset || "utf-8"); } catch { return { text: new TextDecoder("utf-8").decode(bytes), unknown: true }; }
  return { text: decoder.decode(bytes), unknown: false };
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") {
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; // not a character: keep as written
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const BLOCKS = "p, div, br, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table, section, article, header, footer, title, blockquote, pre";

// Visible text of an HTML page: script/style/noscript dropped, a line break around block elements.
export function htmlToText(html: string): string {
  let skip = 0;
  let out = "";
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript", {
      element(el) { skip++; el.onEndTag(() => { skip--; }); },
    })
    .on(BLOCKS, {
      element(el) {
        out += "\n";
        try { el.onEndTag(() => { out += "\n"; }); } catch { /* void element (br): no end tag */ }
      },
    })
    .onDocument({ text(t) { if (skip === 0) out += t.text; } });
  rewriter.transform(html);
  return unescape(out).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (declared > LINK_MAX_BYTES) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LINK_MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return bytes;
}

export async function fetchLink(link: string, deps: LinkDeps = defaults): Promise<LinkResult> {
  let url: URL;
  try { url = new URL(link); } catch { return { kind: "refused", why: "not a URL" }; }
  // The stored and returned name never carries a user name or password from the link.
  const nameOf = (u: URL) => { const c = new URL(u); c.username = ""; c.password = ""; return c.toString(); };
  const failed = (reason: Extract<LinkOutcome, { status: "failed" }>["reason"], mime: string | null = null,
    bytes: Uint8Array | null = null): LinkResult => ({ kind: "fetched", name: nameOf(url), mime, bytes, outcome: { status: "failed", reason } });

  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    const why = await refusal(url, deps);
    if (why === "unresolvable") return failed("link_unreachable");
    if (why) return { kind: "refused", why };
    try {
      res = await deps.fetch(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return failed("link_unreachable");
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return failed("link_unreachable");
      try { url = new URL(location, url); } catch { return failed("link_unreachable"); }
      continue;
    }
    break;
  }
  if (!res.ok) return failed("link_unreachable");

  const [type, ...params] = (res.headers.get("content-type") ?? "").split(";").map((p) => p.trim());
  const mime = type ? type.toLowerCase() : null;
  const charset = params.find((p) => p.toLowerCase().startsWith("charset="))?.slice(8).replace(/"/g, "");
  let bytes: Uint8Array | null;
  try { bytes = await readCapped(res); } catch { return failed("link_unreachable", mime); }
  if (bytes === null) return failed("link_too_large", mime);

  const read = (text: string, note?: "charset_unknown"): LinkResult => tooLong(text)
    ? failed("text_too_large", mime, bytes)
    : { kind: "fetched", name: nameOf(url), mime, bytes, outcome: { status: "read", text, ...(note ? { note } : {}) } };
  if (mime === "text/html" || mime === "text/plain") {
    try {
      const { text, unknown } = decode(bytes, charset);
      return read(mime === "text/html" ? htmlToText(text) : text, unknown ? "charset_unknown" : undefined);
    } catch {
      return failed("extract_error", mime, bytes);
    }
  }
  if (mime === "application/pdf") {
    // The same rules as an uploaded PDF: a broken one is `unreadable_pdf`; bytes that are no PDF are unsupported.
    const e = await extract(bytes, "link.pdf");
    if (e.status === "read") return read(e.text);
    if (e.status === "unsupported") return failed("link_unsupported", mime, bytes);
    return failed(e.reason === "unreadable_pdf" || e.reason === "text_too_large" ? e.reason : "extract_error", mime, bytes);
  }
  return failed("link_unsupported", mime, bytes);
}
