import "./style.css";
import { App } from "./app";

function boot(): void {
  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const palette = document.getElementById("toolpalette");
  const topbar = document.getElementById("topbar");
  const settingsbar = document.getElementById("settingsbar");
  const constraintbar = document.getElementById("constraintbar");
  const statusbar = document.getElementById("statusbar");

  if (!canvas || !palette || !topbar || !settingsbar || !constraintbar || !statusbar) {
    throw new Error("RapidCAM: required DOM elements are missing");
  }

  new App(canvas, { palette, topbar, settingsbar, constraintbar, statusbar });
}

boot();
