import "./style.css";
import { installErrorCapture, showConsentBannerIfNeeded } from "./analytics";
import { App } from "./app";
import { installLongTaskWatch, longTasks } from "./core/longTasks";
import { syncColorsFromTheme } from "./view/colors";

declare global {
  interface Window {
    /** Dev-only inspection hook for automated UI verification (absent in prod builds). */
    __app?: App;
    /** Dev-only: blocks over 200ms this session, worst first. See core/longTasks.ts. */
    __longTasks?: typeof longTasks;
  }
}

function wireRightPanelTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".rtab");
  const panels = document.querySelectorAll<HTMLElement>(".rtab-content");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
      });
      panels.forEach((p) => {
        p.classList.toggle("active", p.dataset.panel === target);
      });
    });
  });
}

function showMobileWarning(): boolean {
  const isSmallScreen = window.innerWidth < 1024 || window.innerHeight < 600;
  const isTouch = navigator.maxTouchPoints > 1 && !window.matchMedia("(pointer: fine)").matches;
  if (!isSmallScreen && !isTouch) return false;

  const overlay = document.createElement("div");
  overlay.className = "mobile-warning";
  overlay.innerHTML = `
    <div class="mobile-warning-card">
      <img src="/rapidcam-logo.svg" alt="RapidCAM" class="mobile-warning-logo" />
      <h1 class="mobile-warning-title">RapidCAM</h1>
      <p class="mobile-warning-body">
        RapidCAM is a precision CAD/CAM tool designed for desktop use.
        It requires a keyboard, mouse, and a screen at least 1024&nbsp;px wide
        to use effectively.
      </p>
      <p class="mobile-warning-body">
        Please open it on a desktop or laptop computer.
      </p>
      <button class="mobile-warning-continue">Continue anyway</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".mobile-warning-continue")!.addEventListener("click", () => {
    overlay.remove();
    bootApp();
  });
  return true;
}

function bootApp(): void {
  // Pull the CSS theme tokens into the canvas palette before anything renders.
  syncColorsFromTheme();

  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const palette = document.getElementById("toolpalette");
  const designtree = document.getElementById("design-tree-container");
  const topbar = document.getElementById("topbar");
  const layersbar = document.getElementById("layersbar");
  const settingsbar = document.getElementById("settingsbar");
  const propertiesbar = document.getElementById("propertiesbar");
  const cambar = document.getElementById("cambar");
  const variablesbar = document.getElementById("variablesbar");
  const constraintbar = document.getElementById("constraintbar");
  const alignbar = document.getElementById("alignbar");
  const statusbar = document.getElementById("statusbar");
  const canvasHost = document.getElementById("canvas-host");
  const webglHost = document.getElementById("webgl-host");
  const splitDivider = document.getElementById("split-divider");

  if (
    !canvas ||
    !palette ||
    !designtree ||
    !topbar ||
    !layersbar ||
    !settingsbar ||
    !propertiesbar ||
    !cambar ||
    !variablesbar ||
    !constraintbar ||
    !alignbar ||
    !statusbar ||
    !canvasHost ||
    !webglHost ||
    !splitDivider
  ) {
    throw new Error("RapidCAM: required DOM elements are missing");
  }

  const app = new App(canvas, {
    palette,
    designtree,
    topbar,
    layersbar,
    settingsbar,
    propertiesbar,
    cambar,
    variablesbar,
    constraintbar,
    alignbar,
    statusbar,
    canvasHost,
    webglHost,
    splitDivider,
  });
  wireRightPanelTabs();
  showConsentBannerIfNeeded();
  // Dev-only inspection hook for automated UI verification (stripped from prod builds).
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    window.__app = app;
    window.__longTasks = longTasks;
  }
}

// Before anything runs, so a failure during App construction or draft restore is
// reported too. Consent-gated internally — installing early captures nothing on
// its own.
installErrorCapture();
// Likewise early: boot and document restore are themselves candidates for the
// blocks this watches for.
installLongTaskWatch();

if (!showMobileWarning()) bootApp();
