/** Bottom status bar: live cursor coordinates, zoom, and snap toggles. */

import type { Vec2 } from "../core/vec2";
import { fromMM } from "../core/units";
import type { CADDocument } from "../model/document";
import type { SnapEngine } from "../input/snapping";
import type { SolveResult } from "../solver/solver";

/** How a solve state should read in the status bar. `null` = show nothing (an
 *  unconstrained sketch has no meaningful "definedness" to report yet). */
export interface SolveStatusLabel {
  html: string;
  /** CSS color (token or literal) for the status text. */
  color: string;
  /** Plain-language explanation, shown on hover — the DOF number alone tells a
   *  newcomer nothing about what it means or what to do. */
  tooltip: string;
}

/**
 * Translate a solve result into a legible status label. Pure (no DOM) so it is
 * unit-testable; {@link StatusBar.setSolveStatus} just applies it.
 *
 * The under-constrained case is the one that used to read as a bare "DOF 5" —
 * jargon that hides the two things a newcomer needs to know: geometry can still
 * move, and editing one value may shift another. Green = locked, blue = the CAD
 * convention for "not fully defined yet", red = conflicting.
 */
/**
 * @param hasUnderDefined whether any entity is actually drawn under-defined
 *   (blue). Lets the bar agree with the canvas: geometry that is programmatically
 *   controlled (a generator feature, a pattern instance) has free solver DOF but
 *   is NOT loose, so a feature-only sketch reads "Fully constrained" even though
 *   `res.dof > 0`. Defaults to `res.dof > 0` when omitted (pure-DOF callers/tests).
 */
export function solveStatusLabel(
  res: SolveResult | null,
  hasUnderDefined?: boolean,
): SolveStatusLabel | null {
  // Nothing solvable on the canvas (empty, or only fixed geometry) → no status
  // to report. Otherwise ALWAYS report definedness — matching the SolidWorks
  // model where a fresh, unconstrained sketch already reads "under-defined"
  // (and its geometry is drawn blue), not blank until the first constraint.
  if (!res || res.variables === 0) return null;
  const underDefined = hasUnderDefined ?? res.dof > 0;
  if (!res.converged) {
    return {
      html: "⚠ Over-constrained / conflicting",
      color: "var(--danger)",
      tooltip:
        "Conflicting or redundant constraints — the sketch can't satisfy them all at once. Remove a constraint or dimension to resolve it.",
    };
  }
  if (!underDefined) {
    return {
      html: "Fully constrained ✓",
      color: "#3fb950",
      tooltip:
        "Nothing is loose — the geometry can't move unless you change a dimension, a variable, or a feature parameter.",
    };
  }
  const n = res.dof;
  return {
    html: `Under-constrained · <b>${n}</b> free`,
    color: "var(--accent)",
    tooltip:
      `${n} degree${n === 1 ? "" : "s"} of freedom (DOF) are still unconstrained — this sketch can move, ` +
      "and editing one value may shift other geometry. Add dimensions or constraints to pin it down (0 = fully constrained).",
  };
}

export class StatusBar {
  private coordEl!: HTMLElement;
  private zoomEl!: HTMLElement;
  private solveEl!: HTMLElement;
  private patternEl!: HTMLElement;
  private flashEl!: HTMLElement;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private hintEl!: HTMLElement;
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

    this.patternEl = statusItem("");
    this.patternEl.style.color = "var(--warn, #c8982a)";
    this.host.appendChild(this.patternEl);

    this.flashEl = statusItem("");
    this.host.appendChild(this.flashEl);

    this.hintEl = statusItem("");
    this.hintEl.style.opacity = "0.9";
    this.host.appendChild(this.hintEl);

    const spacer = document.createElement("div");
    spacer.className = "status-spacer";
    this.host.appendChild(spacer);

    this.gridToggle = this.toggle(
      "Grid snap",
      () => {
        this.snap.gridEnabled = !this.snap.gridEnabled;
        this.refreshToggles();
        this.onToggle();
      },
      "Drawing clicks and moved geometry land on the grid",
    );
    this.osnapToggle = this.toggle(
      "Object snap",
      () => {
        this.snap.objectSnapEnabled = !this.snap.objectSnapEnabled;
        this.refreshToggles();
        this.onToggle();
      },
      "Endpoints, midpoints and centres attract the cursor and moved geometry — hold Ctrl during a drag to skip once",
    );
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

  /** Persistent usage hint for the active tool ("" hides it). */
  setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  /** Transient message (why an interaction was refused, what a tool did).
   *  Auto-clears after a short delay; a new flash replaces the previous one. */
  flash(msg: string, tone: "warn" | "info" = "warn"): void {
    this.flashEl.textContent = msg;
    this.flashEl.style.color = tone === "warn" ? "var(--warn, #c8982a)" : "";
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashEl.textContent = "";
      this.flashTimer = null;
    }, 2500);
  }

  setZoom(scale: number): void {
    // scale is px/mm; report as a percentage relative to 1px ≈ 1 screen unit.
    this.zoomEl.innerHTML = `Zoom <b>${(scale * 10).toFixed(0)}%</b>`;
  }

  setPatternStatus(staleCount: number): void {
    if (staleCount === 0) {
      this.patternEl.textContent = "";
    } else {
      const n = staleCount === 1 ? "1 pattern" : `${staleCount} patterns`;
      this.patternEl.textContent = `⟳ ${n} stale — Ctrl+Shift+P`;
    }
  }

  setSolveStatus(res: SolveResult | null, hasUnderDefined?: boolean): void {
    const label = solveStatusLabel(res, hasUnderDefined);
    if (!label) {
      this.solveEl.textContent = "";
      this.solveEl.style.color = "";
      this.solveEl.title = "";
      return;
    }
    this.solveEl.innerHTML = label.html;
    this.solveEl.style.color = label.color;
    this.solveEl.title = label.tooltip;
  }

  private toggle(label: string, onClick: () => void, tooltip?: string): HTMLElement {
    const e = document.createElement("div");
    e.className = "status-toggle";
    e.textContent = label;
    if (tooltip) e.title = tooltip;
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
