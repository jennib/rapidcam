import "./style.css";
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

function boot(): void {
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

  new App(canvas, { palette, topbar, layersbar, settingsbar, propertiesbar, cambar, variablesbar, constraintbar, statusbar, canvasHost, webglHost, splitDivider });
  wireRightPanelTabs();
}

boot();
