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
 * The load path is the cncjs-standard `POST /api/gcode { port, name, gcode }`,
 * which loads the program into the controller's sender (it then shows in
 * gSender's workspace, ready to run). That needs the serial `port`, which we
 * discover from `GET /api/controllers` (each entry carries `.port`).
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
  /** Serial port the program was loaded onto, on success. */
  port?: string;
  /** User-facing explanation on failure. */
  error?: string;
  /** Coarse failure class for the caller's UX: unreachable | no-controller | rejected. */
  hint?: "unreachable" | "no-controller" | "rejected";
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

/** A message for a thrown fetch error (network down, CORS, timeout, mixed-content). */
function unreachableMsg(base: string): string {
  return (
    `Couldn't reach gSender at ${base}. Make sure gSender is running with ` +
    `Remote/Wireless Control enabled and the address is correct. ` +
    `(A https page can only reach gSender on http://localhost, not a plain-http LAN address.)`
  );
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

/** Connected controllers' serial ports, via GET /api/controllers. */
async function fetchPorts(base: string, token: string | undefined, fetchImpl: FetchLike): Promise<string[]> {
  const res = await timedFetch(fetchImpl, `${base}/api/controllers`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list.map((c) => c?.port).filter((p): p is string => !!p) : [];
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
    const ports = await fetchPorts(base, token, fetchImpl);
    return { ok: true, ports };
  } catch {
    return { ok: false, ports: [], error: unreachableMsg(base) };
  }
}

/**
 * Load `gcode` into a running gSender. Resolves with `ok: true` and the target
 * port on success; otherwise `ok: false` with a user-facing `error` and a coarse
 * `hint` so the caller can tailor its fallback (e.g. offer a file download).
 */
export async function sendToGsender(
  baseUrl: string,
  name: string,
  gcode: string,
  fetchImpl: FetchLike = fetch,
): Promise<GsenderSendResult> {
  const base = normalizeGsenderUrl(baseUrl);
  if (!base) return { ok: false, error: "No gSender address configured.", hint: "unreachable" };

  // Reach gSender (token is best-effort; a network throw here means it's down).
  let token: string | undefined;
  try {
    token = await signin(base, fetchImpl);
  } catch {
    return { ok: false, error: unreachableMsg(base), hint: "unreachable" };
  }

  // Which machine to load onto.
  let ports: string[];
  try {
    ports = await fetchPorts(base, token, fetchImpl);
  } catch {
    return { ok: false, error: unreachableMsg(base), hint: "unreachable" };
  }
  if (ports.length === 0) {
    return {
      ok: false,
      hint: "no-controller",
      error: "gSender is reachable but no CNC is connected. Connect your machine in gSender, then send again.",
    };
  }
  const port = ports[0];

  // Load it.
  try {
    const res = await timedFetch(fetchImpl, `${base}/api/gcode`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ port, name, gcode }),
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
