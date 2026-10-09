// SPEC-A-005 § S2.5: tell CAW a version was confirmed. Best effort — one attempt, 2 s, failure only logged as a code;
// the pull feed (`GET …/versions?after=`) is the guarantee (AC-6). `CAW_NOTIFY_URL` empty = never any outbound call.
export const NOTIFY_TIMEOUT_MS = 2_000;

let reportedBad: string | null = null; // a bad URL is reported once per value, not on every confirm

export async function notifyConfirmed(notice: { projectId: string; version: number; confirmedAt: string }): Promise<void> {
  const raw = process.env.CAW_NOTIFY_URL?.trim() ?? ""; // read at call time
  if (!raw) return;
  let url: URL | null = null;
  try { url = new URL(raw); } catch { /* reported below */ }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    if (reportedBad !== raw) console.error(`[notify] ignored reason=${url ? "not_http" : "bad_url"}`); // codes only — never the URL
    reportedBad = raw;
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "version.confirmed", ...notice }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`[notify] failed reason=http_${res.status}`);
  } catch (e) {
    const name = (e as { name?: string }).name;
    console.error(`[notify] failed reason=${name === "TimeoutError" || name === "AbortError" ? "timeout" : "network"}`);
  }
}
