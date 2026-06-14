import "./style.css";
import { showConsentBannerIfNeeded } from "./analytics";
import { App } from "./app";

function wireRightPanelTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".rtab");
  const panels = document.querySelectorAll<HTMLElement>(".rtab-content");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => p.classList.toggle("active", p.dataset.panel === target));
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
  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const palette = document.getElementById("toolpalette");
  const topbar = document.getElementById("topbar");
  const layersbar = document.getElementById("layersbar");
  const settingsbar = document.getElementById("settingsbar");
  const propertiesbar = document.getElementById("propertiesbar");
  const cambar = document.getElementById("cambar");
  const variablesbar = document.getElementById("variablesbar");
  const constraintbar = document.getElementById("constraintbar");
  const statusbar = document.getElementById("statusbar");
  const canvasHost = document.getElementById("canvas-host");
  const webglHost = document.getElementById("webgl-host");
  const splitDivider = document.getElementById("split-divider");

  if (!canvas || !palette || !topbar || !layersbar || !settingsbar || !propertiesbar || !cambar || !variablesbar || !constraintbar || !statusbar || !canvasHost || !webglHost || !splitDivider) {
    throw new Error("RapidCAM: required DOM elements are missing");
  }

  const app = new App(canvas, { palette, topbar, layersbar, settingsbar, propertiesbar, cambar, variablesbar, constraintbar, statusbar, canvasHost, webglHost, splitDivider });
  wireRightPanelTabs();
  showConsentBannerIfNeeded();
  // Dev-only inspection hook for automated UI verification (stripped from prod builds).
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as { __app: unknown }).__app = app;
  }
}

if (!showMobileWarning()) bootApp();
