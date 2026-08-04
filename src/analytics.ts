/**
 * Privacy-respecting analytics wrapper around PostHog.
 *
 * Nothing is captured until the user gives explicit, informed consent:
 *   - Importing this module has NO side effects (no network, no init).
 *   - `track()` is a no-op until consent is granted and PostHog is initialised.
 *   - Browsers with "Do Not Track" enabled are never tracked, and aren't even
 *     shown the consent banner.
 *   - The PostHog library itself is loaded lazily (dynamic import) only once
 *     consent is granted, so it never enters the bundle that decline/DNT users
 *     download — it's a separate chunk fetched on demand.
 *
 * Consent is stored in localStorage so the choice persists across sessions and
 * can be revoked. Call `showConsentBannerIfNeeded()` once at startup.
 */
import type { PostHog } from "posthog-js";
import { StorageKeys } from "./core/storageKeys";

const CONSENT_KEY = StorageKeys.analyticsConsent;
const REPLAY_CONSENT_KEY = StorageKeys.analyticsReplayConsent;
type Consent = "granted" | "denied";

let initialised = false;
let posthog: PostHog | null = null;

function doNotTrack(): boolean {
  // navigator.doNotTrack === "1", or legacy window.doNotTrack / msDoNotTrack.
  const dnt =
    navigator.doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack ??
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack;
  return dnt === "1" || dnt === "yes";
}

function readConsent(key: string): Consent | null {
  try {
    const v = localStorage.getItem(key);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function writeConsent(key: string, value: Consent): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — treat as session-only */
  }
}

export function getConsent(): Consent | null {
  return readConsent(CONSENT_KEY);
}

/**
 * Consent for session replay specifically. Replay captures the on-screen
 * drawing (canvas pixels), which is not anonymous, so it is a separate, stricter
 * opt-in: it is never "granted" unless the user explicitly asked for it, even if
 * usage analytics is allowed.
 */
export function getReplayConsent(): Consent | null {
  return readConsent(REPLAY_CONSENT_KEY);
}

/**
 * Initialise PostHog. Only ever runs once, and only with consent + no DNT.
 * The library is dynamically imported here so it's code-split out of the main
 * bundle — decline/DNT users never download it.
 */
export async function initAnalytics(): Promise<void> {
  if (initialised) return;
  if (doNotTrack()) return;
  if (getConsent() !== "granted") return;

  const { default: ph } = await import("posthog-js");
  // A second caller may have initialised while the dynamic import was in flight.
  if (initialised) return;
  posthog = ph;

  // Session replay records the actual on-screen drawing (canvas pixels), so it
  // is gated behind its own explicit opt-in and stays off unless the user asked
  // for it — even though they've allowed usage analytics.
  const replay = getReplayConsent() === "granted";

  posthog.init("phc_u9sEREoykrDKErEtysyiAiRTRAEDcfKxE5y6HQcFsWMn", {
    api_host: "https://us.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    respect_dnt: true,
    disable_session_recording: !replay,
    session_recording: {
      // The drawing lives in a <canvas>, which rrweb does NOT capture from the
      // DOM — without this, replays show the cursor and dialogs but a blank
      // canvas. recordCanvas streams the pixels (at a throttled fps) so the
      // geometry is visible in session replays. Only takes effect when replay
      // consent is granted (otherwise recording is disabled above).
      captureCanvas: {
        recordCanvas: true,
        canvasFps: 4,
        canvasQuality: "0.6",
      },
    },
  });
  initialised = true;
  flushPendingErrors();
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!initialised || !posthog) return;
  posthog.capture(event, props);
}

/* ------------------------------------------------------------------------- *
 * Error capture
 *
 * Consent-gated exactly like `track()`: `captureError` no-ops until PostHog is
 * initialised, so an exception thrown before the user answers the banner (or by
 * a user who declined, or has DNT set) is dropped rather than queued. That is
 * deliberate — a stack trace can name a file the user opened, so it is analytics
 * data and lives behind the same gate, not outside it.
 * ------------------------------------------------------------------------- */

/**
 * Signatures already reported this session. The canvas render loop runs at
 * frame rate, so a single bad entity can throw 60×/second — without this, one
 * bug becomes thousands of identical events and the quota is gone in a minute.
 * Reporting the FIRST occurrence of each distinct signature keeps the signal.
 */
const seenErrors = new Set<string>();

/**
 * Hard cap on distinct signatures per session. A stack that varies every frame
 * (e.g. a coordinate baked into the message) would defeat the dedupe set above,
 * so this bounds the damage even then.
 */
const MAX_DISTINCT_ERRORS = 25;

let errorCaptureInstalled = false;

/** name + message + first stack frame — stable across repeats, distinct across bugs. */
function errorSignature(err: unknown): string {
  if (err instanceof Error) {
    const frame = err.stack?.split("\n")[1]?.trim() ?? "";
    return `${err.name}: ${err.message} @ ${frame}`;
  }
  return String(err);
}

/**
 * Report a caught exception. Safe to call from anywhere, including a `catch`
 * that must not itself throw — every failure path here is swallowed.
 *
 * `context` should carry only non-identifying facts (counts, enum values, which
 * operation was running). Never pass geometry, file contents or file paths.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  try {
    // Dedupe ONCE, on the way in — before the send/buffer fork. Doing it here
    // rather than at send time is what bounds `pendingErrors`: a render loop
    // throwing at frame rate during startup adds one entry, not hundreds.
    const sig = errorSignature(err);
    if (seenErrors.has(sig)) return;
    if (seenErrors.size >= MAX_DISTINCT_ERRORS) return;
    seenErrors.add(sig);

    if (!initialised || !posthog) {
      // PostHog loads via dynamic import, so there is a window at startup where
      // consent is granted but the library is still in flight — exactly when the
      // worst errors (boot, document restore) happen. Hold those, and ONLY those:
      // a user who has not consented, or declined, gets nothing buffered.
      if (getConsent() === "granted" && !doNotTrack()) pendingErrors.push([err, context]);
      return;
    }

    posthog.captureException(err, context);
  } catch {
    /* analytics must never break the app it is measuring */
  }
}

/**
 * Errors caught while the PostHog import was still in flight. Bounded by the
 * dedupe in `captureError`, which runs before anything lands here.
 */
const pendingErrors: [unknown, Record<string, unknown> | undefined][] = [];

/**
 * Drain the startup buffer once PostHog is live. Sends directly rather than
 * re-entering `captureError`, whose dedupe has already accepted these and would
 * now reject them as repeats.
 */
function flushPendingErrors(): void {
  if (!posthog) return;
  for (const [err, context] of pendingErrors.splice(0, pendingErrors.length)) {
    try {
      posthog.captureException(err, context);
    } catch {
      /* analytics must never break the app it is measuring */
    }
  }
}

/**
 * Install global handlers for otherwise-unreported failures: exceptions that
 * escape to the window, and rejected promises nobody caught.
 *
 * Installed unconditionally at boot rather than on consent, because consent can
 * be granted mid-session and the handler is itself consent-gated — installing
 * early costs nothing and means the first error after a grant is still caught.
 * Idempotent.
 */
export function installErrorCapture(): void {
  if (errorCaptureInstalled) return;
  if (typeof window === "undefined") return;
  errorCaptureInstalled = true;

  window.addEventListener("error", (e: ErrorEvent) => {
    // The `error` event also fires for failed resource loads (<img>, <script>),
    // where there is no exception object and the target is an element, not the
    // window. Those are not crashes — reporting them as such would bury the
    // real ones.
    if (!e.error) return;
    captureError(e.error, { source: "window.error" });
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    captureError(e.reason, { source: "unhandledrejection" });
  });
}

/** Whether the browser has Do Not Track set (exposed for the privacy dialog). */
export function isDoNotTrack(): boolean {
  return doNotTrack();
}

/**
 * Apply a consent choice, persisting it and reconciling the live PostHog
 * instance so the change takes effect without a reload:
 *   - turning analytics off opts out of capture and stops any recording;
 *   - turning it on initialises (first time) or opts back in;
 *   - replay (canvas capture) is started/stopped to match, and is only ever on
 *     when analytics is also on.
 * Do Not Track always wins: the choice is stored, but nothing is captured.
 */
async function applyConsent(analytics: boolean, replay: boolean): Promise<void> {
  writeConsent(CONSENT_KEY, analytics ? "granted" : "denied");
  writeConsent(REPLAY_CONSENT_KEY, analytics && replay ? "granted" : "denied");

  if (doNotTrack()) return;

  if (!analytics) {
    posthog?.stopSessionRecording?.();
    posthog?.opt_out_capturing?.();
    return;
  }

  if (!initialised) {
    // First opt-in: init reads the consent we just wrote (incl. replay gate).
    await initAnalytics();
    return;
  }

  posthog?.opt_in_capturing?.();
  if (replay) posthog?.startSessionRecording?.();
  else posthog?.stopSessionRecording?.();
}

/**
 * Record the user's choice; initialise immediately if they accepted.
 * `replay` is the separate, stricter opt-in for session replay (canvas capture)
 * and defaults to off — granting usage analytics never implies replay.
 */
export function grantConsent(replay = false): Promise<void> {
  return applyConsent(true, replay);
}

export function denyConsent(): Promise<void> {
  return applyConsent(false, false);
}

/** Set both consents at once (used by the Help → Privacy dialog). */
export function setConsentChoices(analytics: boolean, replay: boolean): Promise<void> {
  return applyConsent(analytics, replay);
}

/**
 * On startup: if the user already chose, honour it silently (initialising
 * PostHog only when previously granted). Otherwise — and only when DNT is not
 * set — show a small, non-blocking consent banner.
 */
export function showConsentBannerIfNeeded(): void {
  if (doNotTrack()) return; // never track, never nag

  const existing = getConsent();
  if (existing === "granted") {
    void initAnalytics();
    return;
  }
  if (existing === "denied") return;

  renderBanner();
}

function renderBanner(): void {
  if (document.getElementById("analytics-consent-banner")) return;

  const banner = document.createElement("div");
  banner.id = "analytics-consent-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Analytics consent");
  banner.style.cssText = [
    "position:fixed",
    // Anchor to the BOTTOM. As a popover this element is in the top layer with
    // the UA `[popover]:popover-open { inset:0 }` rule; setting only `bottom`
    // left the UA `top:0` in force, so the banner rendered pinned to the TOP,
    // covering the menu bar and reading as a second modal over the New Project
    // dialog. An explicit four-side inset (top:auto) overrides that.
    "inset:auto 16px 16px 16px",
    "max-width:520px",
    "margin:0 auto",
    "z-index:10000",
    "background:#1e1e1e",
    "color:#ddd",
    "border:1px solid #3a3a3a",
    "border-radius:8px",
    "padding:14px 16px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
    "font:13px/1.5 system-ui,sans-serif",
    "display:flex",
    "gap:12px",
    "align-items:center",
    "flex-wrap:wrap",
  ].join(";");

  const text = document.createElement("span");
  text.style.flex = "1 1 240px";
  text.textContent =
    "RapidCAM can send anonymous usage analytics and crash reports to help " +
    "improve the app. Nothing is collected unless you allow it.";

  // Separate, opt-in-only checkbox for session replay. This records the actual
  // on-screen drawing (canvas pixels), so it's clearly distinguished from the
  // anonymous usage events above and left unchecked by default.
  const replayLabel = document.createElement("label");
  replayLabel.style.cssText = [
    "flex:1 1 100%",
    "display:flex",
    "gap:8px",
    "align-items:flex-start",
    "cursor:pointer",
    "color:#bbb",
    "font-size:12px",
  ].join(";");
  const replayCheck = document.createElement("input");
  replayCheck.type = "checkbox";
  replayCheck.style.marginTop = "2px";
  const replayText = document.createElement("span");
  replayText.textContent =
    "Also allow session replay, which records my on-screen drawing to help " +
    "debug issues. (Optional — leave unchecked to keep your geometry private.)";
  replayLabel.append(replayCheck, replayText);

  const accept = document.createElement("button");
  accept.textContent = "Allow analytics";
  const decline = document.createElement("button");
  decline.textContent = "No thanks";

  for (const b of [accept, decline]) {
    b.style.cssText = [
      "padding:6px 14px",
      "border-radius:6px",
      "border:1px solid #4a4a4a",
      "cursor:pointer",
      "font:inherit",
      "white-space:nowrap",
    ].join(";");
  }
  accept.style.background = "#2d6cdf";
  accept.style.color = "#fff";
  accept.style.borderColor = "#2d6cdf";
  decline.style.background = "transparent";
  decline.style.color = "#ddd";

  const close = () => banner.remove();
  accept.addEventListener("click", () => {
    grantConsent(replayCheck.checked);
    close();
  });
  decline.addEventListener("click", () => {
    denyConsent();
    close();
  });

  banner.append(text, replayLabel, accept, decline);
  
  if (banner.showPopover) {
    banner.setAttribute("popover", "manual");
    document.body.appendChild(banner);
    banner.showPopover();
  } else {
    document.body.appendChild(banner);
  }
}
