/**
 * "Send to gSender" — hand a generated program straight to a running gSender
 * without the download → open-file detour.
 *
 * gSender (Sienci Labs) is an Electron app whose main process runs a small HTTP
 * server (the cncjs lineage). Two facts make a browser handoff possible:
 *   - it mounts `cors()` with no options, so it answers cross-origin requests
 *     from any page (including rapidcam.app);
 *   - its JWT guard is effectively a no-op (the failure handler bypasses), and
 *     `POST /api/signin` hands out a token even with no users configured — so we
 *     grab one for forwards-compatibility but don't depend on it.
 *
 * The load path is `POST /api/file` (multipart, field name `gcode`). Its handler
 * calls `CNCEngine.load`, which *always* broadcasts `file:load` to connected UI
 * clients — so the program appears in gSender's workspace **whether or not a
 * machine is connected** — and *additionally* loads it onto the sender (ready to
 * run) when a serial `port` is supplied. So we discover a connected port from
 * `GET /api/controllers` (each entry carries `.port`) as a best-effort bonus, but
 * a missing connection never blocks the send: the file still lands in gSender,
 * waiting for the operator to connect and press Play. (`POST /api/gcode` is the
 * other load endpoint, but it hard-requires a connected controller, so we don't
 * use it.)
 *
 * Reachability caveats the caller surfaces to the user:
 *   - The desktop app's own server binds a *random* localhost port; the known,
 *     reachable address (default `:8000`) appears once **Remote/Wireless Control**
 *     is enabled in gSender. That's the address to configure.
 *   - From an https page, Chromium allows fetches to `http://localhost` (exempt
 *     from mixed-content blocking) but NOT to a plain-http LAN IP. Same-machine
 *     localhost is the common, working case.
 */

export interface GsenderSendResult {
  ok: boolean;
  /** Serial port the program was also loaded onto (undefined = no machine connected). */
  port?: string;
  /** User-facing explanation on failure. */
  error?: string;
  /** Coarse failure class for the caller's UX. */
  hint?: "unreachable" | "rejected" | "busy";
}

export interface GsenderTestResult {
  ok: boolean;
  /** Ports of currently-connected controllers (empty = gSender up, no machine). */
  ports: string[];
  error?: string;
}

/** Injectable for tests; defaults to the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 5000;

/** Trim, default the scheme to http, and drop any trailing slash. */
export function normalizeGsenderUrl(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

/** fetch with an abort-based timeout so an unreachable host fails fast. */
async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * True when a failure is very likely the browser blocking active mixed content:
 * this page is https, but the gSender address is plain http on a non-loopback
 * host (a remote/shop machine). A blocked fetch throws the same generic error as
 * a connection failure, so we infer it from the address rather than the error.
 */
function mixedContentLikely(base: string): boolean {
  if (typeof location === "undefined" || location.protocol !== "https:") return false;
  try {
    const u = new URL(base);
    return u.protocol === "http:" && !isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/** A message for a thrown fetch error (network down, CORS, timeout, mixed-content). */
function unreachableMsg(base: string): string {
  const head =
    `Couldn't reach gSender at ${base}. Make sure gSender is running with ` +
    `Remote/Wireless Control enabled and the address is correct.`;
  if (mixedContentLikely(base)) {
    return (
      `${head} This is a plain-http address on another machine, which your browser ` +
      `blocks from an https page. Allow "Insecure content" for this site in the ` +
      `browser's site settings, or open RapidCAM over http on your network.`
    );
  }
  return head;
}

/** Best-effort token grab. Network failure propagates (a real reachability
 *  problem); a non-OK response just means "carry on without a token". */
async function signin(base: string, fetchImpl: FetchLike): Promise<string | undefined> {
  const res = await timedFetch(fetchImpl, `${base}/api/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return undefined;
  try {
    const body = await res.json();
    return body?.token;
  } catch {
    return undefined;
  }
}

/** The slice of a gSender controller status we care about. */
interface GsenderController {
  port?: string;
  /** 'idle' | 'running' | 'paused' — whether a job is currently streaming. */
  workflow?: { state?: string };
}

/** Connected controllers, via GET /api/controllers. */
async function fetchControllers(base: string, token: string | undefined, fetchImpl: FetchLike): Promise<GsenderController[]> {
  const res = await timedFetch(fetchImpl, `${base}/api/controllers`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

/**
 * Probe a gSender address: is it up, and what machines are connected? Used by the
 * settings "Test" affordance so the user can confirm the address before relying
 * on it mid-job.
 */
export async function testGsenderConnection(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<GsenderTestResult> {
  const base = normalizeGsenderUrl(baseUrl);
  if (!base) return { ok: false, ports: [], error: "No gSender address set." };
  try {
    const token = await signin(base, fetchImpl);
    const ports = (await fetchControllers(base, token, fetchImpl))
      .map((c) => c.port)
      .filter((p): p is string => !!p);
    return { ok: true, ports };
  } catch {
    return { ok: false, ports: [], error: unreachableMsg(base) };
  }
}

/**
 * Load `gcode` into a running gSender via `POST /api/file`. Resolves `ok: true`
 * on success; `port` names the machine it was also loaded onto, or is undefined
 * when no machine is connected (still a success — the file waits in the
 * workspace). On failure, `ok: false` with a user-facing `error` and a coarse
 * `hint` so the caller can offer a file-download fallback.
 */
export async function sendToGsender(
  baseUrl: string,
  name: string,
  gcode: string,
  fetchImpl: FetchLike = fetch,
): Promise<GsenderSendResult> {
  const base = normalizeGsenderUrl(baseUrl);
  if (!base) return { ok: false, error: "No gSender address configured.", hint: "unreachable" };

  // First contact — also our fast reachability gate: a network throw here means
  // gSender is down (bounds the failure path to a single timeout).
  let token: string | undefined;
  try {
    token = await signin(base, fetchImpl);
  } catch {
    return { ok: false, error: unreachableMsg(base), hint: "unreachable" };
  }

  // Best-effort: if a machine is connected, pass its port so gSender also loads
  // the program onto the sender (ready to run). No connection is fine — the file
  // still lands in the workspace, so a discovery hiccup never blocks the send.
  let active: GsenderController | undefined;
  try {
    active = (await fetchControllers(base, token, fetchImpl)).find((c) => !!c.port);
  } catch {
    /* couldn't list controllers — send unconnected; the POST below is the verdict */
  }

  // Refuse to load over a live job. gSender's load path resets the sender's line
  // counters with NO running-guard of its own (loadFile's guard is bypassed on
  // this route), so a send mid-cut would desync/corrupt the running program. The
  // idle case (even with a file already open) is a normal silent replace.
  const wf = active?.workflow?.state;
  if (wf === "running" || wf === "paused") {
    return {
      ok: false,
      hint: "busy",
      error:
        `gSender is currently ${wf} a job on ${active!.port}. Loading a new file would ` +
        `interrupt it — stop or finish that job in gSender first, then send again.`,
    };
  }
  const port = active?.port;

  try {
    const form = new FormData();
    form.append("gcode", new Blob([gcode], { type: "text/plain" }), name);
    if (port) form.append("port", port);
    const res = await timedFetch(fetchImpl, `${base}/api/file`, {
      method: "POST",
      headers: authHeaders(token), // NB: no Content-Type — the browser sets the multipart boundary
      body: form,
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const body = await res.json();
        if (body?.msg) detail = body.msg;
      } catch {
        /* non-JSON error body — keep the status */
      }
      return { ok: false, hint: "rejected", error: `gSender couldn't load the program: ${detail}` };
    }
    return { ok: true, port };
  } catch {
    return { ok: false, error: unreachableMsg(base), hint: "unreachable" };
  }
}
