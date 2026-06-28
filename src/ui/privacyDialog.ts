import {
  getConsent,
  getReplayConsent,
  isDoNotTrack,
  setConsentChoices,
} from "../analytics";

/**
 * Help → Privacy & Analytics. Lets the user view and change both consents at
 * any time (the banner only appears once), including turning session replay off
 * after they'd turned it on. Mirrors the banner's two-tier model: usage
 * analytics, plus a stricter, separate opt-in for session replay (which records
 * the on-screen drawing).
 */
export function showPrivacyDialog(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "welcome-backdrop";
  backdrop.style.zIndex = "9999";

  const panel = document.createElement("div");
  panel.className = "about-dialog";
  panel.style.textAlign = "left";
  panel.style.maxWidth = "440px";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => backdrop.remove());

  const title = document.createElement("h2");
  title.textContent = "Privacy & Analytics";
  title.style.margin = "0 0 8px";

  const dnt = isDoNotTrack();

  const intro = document.createElement("p");
  intro.className = "about-desc";
  intro.style.textAlign = "left";
  intro.textContent = dnt
    ? "Your browser has Do Not Track enabled, so RapidCAM collects nothing and " +
      "never will — these settings are disabled."
    : "All processing is local. Choose what, if anything, RapidCAM may send to " +
      "help improve the app. You can change this at any time.";

  // --- Usage analytics row ---
  const analyticsCheck = document.createElement("input");
  analyticsCheck.type = "checkbox";
  analyticsCheck.checked = getConsent() === "granted";
  const analyticsRow = labelledRow(
    analyticsCheck,
    "Anonymous usage analytics",
    "Coarse interaction events only (e.g. \"tool activated\"). No geometry.",
  );

  // --- Session replay row (stricter, depends on analytics) ---
  const replayCheck = document.createElement("input");
  replayCheck.type = "checkbox";
  replayCheck.checked = getReplayConsent() === "granted";
  const replayRow = labelledRow(
    replayCheck,
    "Session replay",
    "Records the pixels of your on-screen drawing so replays show the geometry. " +
      "Leave off to keep your geometry private.",
  );

  // Replay only makes sense with analytics on; keep it visually gated.
  const syncReplayEnabled = (): void => {
    const on = analyticsCheck.checked && !dnt;
    replayCheck.disabled = !on;
    if (!analyticsCheck.checked) replayCheck.checked = false;
    replayRow.style.opacity = on ? "1" : "0.5";
  };
  analyticsCheck.addEventListener("change", syncReplayEnabled);

  if (dnt) {
    analyticsCheck.disabled = true;
    replayCheck.disabled = true;
  }
  syncReplayEnabled();

  const save = document.createElement("button");
  save.className = "btn";
  save.textContent = "Save";
  save.style.marginTop = "8px";
  save.disabled = dnt;
  save.addEventListener("click", () => {
    void setConsentChoices(analyticsCheck.checked, replayCheck.checked);
    backdrop.remove();
  });

  panel.append(closeBtn, title, intro, analyticsRow, replayRow, save);
  backdrop.appendChild(panel);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

function labelledRow(control: HTMLInputElement, heading: string, detail: string): HTMLElement {
  const row = document.createElement("label");
  row.style.cssText = [
    "display:flex", "gap:10px", "align-items:flex-start", "cursor:pointer",
    "margin:12px 0", "color:#ddd", "font-size:13px", "line-height:1.4",
  ].join(";");
  control.style.marginTop = "2px";
  const text = document.createElement("div");
  const h = document.createElement("div");
  h.textContent = heading;
  h.style.fontWeight = "600";
  const d = document.createElement("div");
  d.textContent = detail;
  d.style.color = "#999";
  d.style.fontSize = "12px";
  text.append(h, d);
  row.append(control, text);
  return row;
}
