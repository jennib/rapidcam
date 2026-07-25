/**
 * "Send to ncSender" — push a generated program straight to a running ncSender instance.
 *
 * Unlike gSender (which uses cncjs endpoints), ncSender uses a pure client-server model
 * and exposes `/api/gcode-files` for uploading programs as multipart form data.
 */

export interface NcsenderSendResult {
  ok: boolean;
  /** User-facing explanation on failure. */
  error?: string;
  /** Coarse failure class for the caller's UX. */
  hint?: "unreachable" | "rejected";
}

export interface NcsenderTestResult {
  ok: boolean;
  error?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 5000;

export function normalizeNcsenderUrl(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function mixedContentLikely(base: string): boolean {
  if (typeof location === "undefined" || location.protocol !== "https:") return false;
  try {
    const u = new URL(base);
    return u.protocol === "http:" && !isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

function unreachableMsg(base: string): string {
  const head =
    `Couldn't reach ncSender at ${base}. Make sure ncSender is running and the address is correct.`;
  if (mixedContentLikely(base)) {
    return (
      `${head} This is a plain-http address on another machine, which your browser ` +
      `blocks from an https page. Allow "Insecure content" for this site in the ` +
      `browser's site settings, or open RapidCAM over http on your network.`
    );
  }
  return head;
}

/**
 * Probe an ncSender address to see if it's reachable.
 */
export async function testNcsenderConnection(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<NcsenderTestResult> {
  const base = normalizeNcsenderUrl(baseUrl);
  if (!base) return { ok: false, error: "No ncSender address set." };
  try {
    // ncSender's frontend or API root should respond.
    await timedFetch(fetchImpl, `${base}/api/gcode-files`, { method: "GET" }).catch(() => 
      timedFetch(fetchImpl, `${base}/`, { method: "GET" })
    );
    return { ok: true };
  } catch (e) {
    // Keep the underlying error out of the UI message but in the console, so a
    // genuine bug (not just an unreachable host) is diagnosable rather than masked.
    console.warn("[ncSender] connection probe failed:", e);
    return { ok: false, error: unreachableMsg(base) };
  }
}

/**
 * Upload a program to ncSender using POST /api/gcode-files
 */
export async function sendToNcsender(
  baseUrl: string,
  name: string,
  gcode: string,
  fetchImpl: FetchLike = fetch,
): Promise<NcsenderSendResult> {
  const base = normalizeNcsenderUrl(baseUrl);
  if (!base) return { ok: false, error: "No ncSender address configured.", hint: "unreachable" };

  try {
    const form = new FormData();
    // Use the file name the user wants, with .nc extension for good measure
    const filename = name.endsWith(".nc") ? name : `${name}.nc`;
    form.append("file", new Blob([gcode], { type: "application/octet-stream" }), filename);
    
    const res = await timedFetch(fetchImpl, `${base}/api/gcode-files`, {
      method: "POST",
      body: form,
      // Omit Content-Type so browser sets the multipart boundary automatically
    });
    
    if (!res.ok) {
      return { ok: false, hint: "rejected", error: `ncSender rejected the program: status ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    // Log the real error (see testNcsenderConnection) rather than swallowing it —
    // a masked TypeError here looks identical to an offline sender otherwise.
    console.warn("[ncSender] upload failed:", e);
    return { ok: false, error: unreachableMsg(base), hint: "unreachable" };
  }
}
