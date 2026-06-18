/**
 * Privacy-respecting analytics wrapper around PostHog.
 *
 * Nothing is captured until the user gives explicit, informed consent:
 *   - Importing this module has NO side effects (no network, no init).
 *   - `track()` is a no-op until consent is granted and PostHog is initialised.
 *   - Browsers with "Do Not Track" enabled are never tracked, and aren't even
 *     shown the consent banner.
 *
 * Consent is stored in localStorage so the choice persists across sessions and
 * can be revoked. Call `showConsentBannerIfNeeded()` once at startup.
 */
import posthog from "posthog-js";

const CONSENT_KEY = "rapidcam_analytics_consent";
type Consent = "granted" | "denied";

let initialised = false;

function doNotTrack(): boolean {
  // navigator.doNotTrack === "1", or legacy window.doNotTrack / msDoNotTrack.
  const dnt =
    navigator.doNotTrack ??
    (window as unknown as { doNotTrack?: string }).doNotTrack ??
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack;
  return dnt === "1" || dnt === "yes";
}

export function getConsent(): Consent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function setConsent(value: Consent): void {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* private mode / storage disabled — treat as session-only */
  }
}

/** Initialise PostHog. Only ever runs once, and only with consent + no DNT. */
export function initAnalytics(): void {
  if (initialised) return;
  if (doNotTrack()) return;
  if (getConsent() !== "granted") return;

  posthog.init("phc_u9sEREoykrDKErEtysyiAiRTRAEDcfKxE5y6HQcFsWMn", {
    api_host: "https://us.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    respect_dnt: true,
    session_recording: {
      // The drawing lives in a <canvas>, which rrweb does NOT capture from the
      // DOM — without this, replays show the cursor and dialogs but a blank
      // canvas. recordCanvas streams the pixels (at a throttled fps) so the
      // geometry is visible in session replays.
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
  if (!initialised) return;
  posthog.capture(event, props);
}

/** Record the user's choice; initialise immediately if they accepted. */
export function grantConsent(): void {
  setConsent("granted");
  initAnalytics();
}

export function denyConsent(): void {
  setConsent("denied");
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
    initAnalytics();
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
  accept.addEventListener("click", () => { grantConsent(); close(); });
  decline.addEventListener("click", () => { denyConsent(); close(); });

  banner.append(text, accept, decline);
  document.body.appendChild(banner);
}
