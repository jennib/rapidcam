import "./style.css";
import { App } from "./app";

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

  if (!canvas || !palette || !topbar || !layersbar || !settingsbar || !propertiesbar || !cambar || !variablesbar || !constraintbar || !statusbar) {
    throw new Error("RapidCAM: required DOM elements are missing");
  }

  new App(canvas, { palette, topbar, layersbar, settingsbar, propertiesbar, cambar, variablesbar, constraintbar, statusbar });
}

boot();
