/** Bottom status bar: live cursor coordinates, zoom, and snap toggles. */

import { Vec2 } from "../core/vec2";
import { fromMM } from "../core/units";
import { CADDocument } from "../model/document";
import { SnapEngine } from "../input/snapping";
import { SolveResult } from "../solver/solver";

export class StatusBar {
  private coordEl!: HTMLElement;
  private zoomEl!: HTMLElement;
  private solveEl!: HTMLElement;
  private gridToggle!: HTMLElement;
  private osnapToggle!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private snap: SnapEngine,
    private onToggle: () => void,
  ) {
    this.build();
    this.doc.onChange(() => this.setCursor(this.lastWorld));
  }

  private lastWorld: Vec2 | null = null;

  private build(): void {
    this.coordEl = statusItem("X 0.00  Y 0.00");
    this.host.appendChild(this.coordEl);

    this.zoomEl = statusItem("");
    this.host.appendChild(this.zoomEl);

    this.solveEl = statusItem("");
    this.host.appendChild(this.solveEl);

    const spacer = document.createElement("div");
    spacer.className = "status-spacer";
    this.host.appendChild(spacer);

    this.gridToggle = this.toggle("Grid snap", () => {
      this.snap.gridEnabled = !this.snap.gridEnabled;
      this.refreshToggles();
      this.onToggle();
    });
    this.osnapToggle = this.toggle("Object snap", () => {
      this.snap.objectSnapEnabled = !this.snap.objectSnapEnabled;
      this.refreshToggles();
      this.onToggle();
    });
    this.host.appendChild(this.gridToggle);
    this.host.appendChild(this.osnapToggle);
    this.refreshToggles();
  }

  setCursor(world: Vec2 | null): void {
    this.lastWorld = world;
    const u = this.doc.displayUnit;
    if (!world) {
      this.coordEl.innerHTML = `X —  Y —  <b>${u}</b>`;
      return;
    }
    const x = fromMM(world.x, u).toFixed(u === "in" ? 3 : 2);
    const y = fromMM(world.y, u).toFixed(u === "in" ? 3 : 2);
    this.coordEl.innerHTML = `X <b>${x}</b>  Y <b>${y}</b>  ${u}`;
  }

  setZoom(scale: number): void {
    // scale is px/mm; report as a percentage relative to 1px ≈ 1 screen unit.
    this.zoomEl.innerHTML = `Zoom <b>${(scale * 10).toFixed(0)}%</b>`;
  }

  setSolveStatus(res: SolveResult | null): void {
    if (!res || !res.hasConstraints) {
      this.solveEl.textContent = "";
      this.solveEl.style.color = "";
      return;
    }
    if (!res.converged) {
      this.solveEl.innerHTML = "⚠ Over-constrained / conflicting";
      this.solveEl.style.color = "var(--danger)";
    } else if (res.dof === 0) {
      this.solveEl.innerHTML = "Fully constrained";
      this.solveEl.style.color = "var(--accent)";
    } else {
      this.solveEl.innerHTML = `DOF <b>${res.dof}</b>`;
      this.solveEl.style.color = "";
    }
  }

  private toggle(label: string, onClick: () => void): HTMLElement {
    const e = document.createElement("div");
    e.className = "status-toggle";
    e.textContent = label;
    e.addEventListener("click", onClick);
    return e;
  }

  private refreshToggles(): void {
    this.gridToggle.classList.toggle("on", this.snap.gridEnabled);
    this.osnapToggle.classList.toggle("on", this.snap.objectSnapEnabled);
  }
}

function statusItem(text: string): HTMLElement {
  const e = document.createElement("div");
  e.className = "status-item";
  e.textContent = text;
  return e;
}
