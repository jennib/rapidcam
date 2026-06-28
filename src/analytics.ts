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
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (!initialised || !posthog) return;
  posthog.capture(event, props);
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
    "position:fixed", "bottom:16px", "left:16px", "right:16px", "max-width:520px",
    "margin:0 auto", "z-index:10000", "background:#1e1e1e", "color:#ddd",
    "border:1px solid #3a3a3a", "border-radius:8px", "padding:14px 16px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.4)", "font:13px/1.5 system-ui,sans-serif",
    "display:flex", "gap:12px", "align-items:center", "flex-wrap:wrap",
  ].join(";");

  const text = document.createElement("span");
  text.style.flex = "1 1 240px";
  text.textContent =
    "RapidCAM can send anonymous usage analytics to help improve the app. " +
    "Nothing is collected unless you allow it.";

  // Separate, opt-in-only checkbox for session replay. This records the actual
  // on-screen drawing (canvas pixels), so it's clearly distinguished from the
  // anonymous usage events above and left unchecked by default.
  const replayLabel = document.createElement("label");
  replayLabel.style.cssText = [
    "flex:1 1 100%", "display:flex", "gap:8px", "align-items:flex-start",
    "cursor:pointer", "color:#bbb", "font-size:12px",
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
      "padding:6px 14px", "border-radius:6px", "border:1px solid #4a4a4a",
      "cursor:pointer", "font:inherit", "white-space:nowrap",
    ].join(";");
  }
  accept.style.background = "#2d6cdf";
  accept.style.color = "#fff";
  accept.style.borderColor = "#2d6cdf";
  decline.style.background = "transparent";
  decline.style.color = "#ddd";

  const close = () => banner.remove();
  accept.addEventListener("click", () => { grantConsent(replayCheck.checked); close(); });
  decline.addEventListener("click", () => { denyConsent(); close(); });

  banner.append(text, replayLabel, accept, decline);
  document.body.appendChild(banner);
}
