/**
 * Constraints toolbar. Each button applies a constraint to the CURRENT selection
 * (whole entities via entity-select, point DOFs via point-select), then triggers
 * a solve. Buttons enable/disable based on whether the selection fits the type.
 */

import { CADDocument } from "../model/document";
import {
  Constraint,
  ConstraintType,
  CONSTRAINT_GLYPH,
  makeConstraint,
  constraintResiduals,
  Geo,
} from "../model/constraints";
import { Entity } from "../model/entities";

interface ButtonSpec {
  type: ConstraintType;
  name: string;
  hint: string;
}

const BUTTONS: (ButtonSpec | "sep")[] = [
  { type: "coincident", name: "Coincident", hint: "Select 2 points" },
  "sep",
  { type: "horizontal", name: "Horizontal", hint: "Select 1 line or 2 points" },
  { type: "vertical", name: "Vertical", hint: "Select 1 line or 2 points" },
  "sep",
  { type: "parallel", name: "Parallel", hint: "Select 2 lines" },
  { type: "perpendicular", name: "Perpendicular", hint: "Select 2 lines" },
  { type: "equal", name: "Equal", hint: "Select 2 lines or 2 circles" },
  "sep",
  { type: "concentric", name: "Concentric", hint: "Select 2 circles" },
  { type: "tangent", name: "Tangent", hint: "Select 1 line and 1 circle/arc, or 2 arcs/circles" },
  { type: "pointOnLine", name: "Point on line", hint: "Select 1 point and 1 line" },
  { type: "pointOnArc", name: "Point on arc", hint: "Select 1 point and 1 arc" },
  { type: "midpoint", name: "Midpoint", hint: "Select 1 point and 1 line" },
  "sep",
  { type: "symmetric", name: "Symmetric", hint: "Select 2 points and 1 line (symmetry axis)" },
  { type: "collinear", name: "Collinear", hint: "Select 2 lines" },
  "sep",
  { type: "fixed", name: "Fix", hint: "Select 1+ entities to lock in place" },
];

type BuildResult = { ok: true; constraints: Constraint[] } | { ok: false; error: string };

export class ConstraintBar {
  private typeButtons: { spec: ButtonSpec; el: HTMLButtonElement }[] = [];
  private msgEl!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private onSolve: () => void,
    private pushHistory: () => void,
    private getDof: () => number,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    const label = document.createElement("span");
    label.className = "cb-label";
    label.textContent = "Constraints";
    this.host.appendChild(label);

    for (const b of BUTTONS) {
      if (b === "sep") {
        const sep = document.createElement("div");
        sep.className = "cb-sep";
        this.host.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "cbtn";
      btn.textContent = CONSTRAINT_GLYPH[b.type];
      btn.title = `${b.name} — ${b.hint}`;
      btn.addEventListener("click", () => this.apply(b));
      this.host.appendChild(btn);
      this.typeButtons.push({ spec: b, el: btn });
    }

    const sep = document.createElement("div");
    sep.className = "cb-sep";
    this.host.appendChild(sep);

    const solveBtn = document.createElement("button");
    solveBtn.className = "cbtn solve";
    solveBtn.textContent = "Solve";
    solveBtn.title = "Re-run the constraint solver";
    solveBtn.addEventListener("click", () => this.onSolve());
    this.host.appendChild(solveBtn);

    this.msgEl = document.createElement("span");
    this.msgEl.className = "cb-msg";
    this.host.appendChild(this.msgEl);
  }

  private apply(spec: ButtonSpec): void {
    const res = this.buildFor(spec.type);
    if (!res.ok) {
      this.message(res.error, "error");
      return;
    }
    // Pre-check: count how many equations the new constraints would add, and
    // reject if it would take the sketch below 0 free DOFs.
    const byId = new Map(this.doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id) => byId.get(id);
    const newEqs = res.constraints.reduce((n, c) => n + constraintResiduals(c, geo).length, 0);
    const dof = this.getDof();
    if (newEqs > 0 && dof - newEqs < 0) {
      this.message(`Would over-constrain (${dof} DOF free, needs ${newEqs})`, "error");
      return;
    }
    this.pushHistory();
    for (const c of res.constraints) this.doc.addConstraint(c);
    this.doc.clearSelection();
    this.onSolve();
    this.message(`Added ${spec.name.toLowerCase()}`, "ok");
  }

  private refresh(): void {
    for (const { spec, el } of this.typeButtons) {
      el.disabled = !this.buildFor(spec.type).ok;
    }
  }

  private message(text: string, kind: "error" | "ok"): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `cb-msg ${kind}`;
  }

  /** Validate the current selection for `type` and, if valid, produce constraints. */
  private buildFor(type: ConstraintType): BuildResult {
    const ents = this.doc.selected;
    const lines = ents.filter((e) => e.type === "line");
    const circles = ents.filter((e) => e.type === "circle");
    const arcs = ents.filter((e) => e.type === "arc");
    const circular = [...circles, ...arcs]; // circles and arcs share radius-based constraints
    const pts = this.doc.selectedPoints;
    const ids = (es: Entity[]) => es.map((e) => e.id);

    const ok = (constraints: Constraint[]): BuildResult => ({ ok: true, constraints });
    const err = (error: string): BuildResult => ({ ok: false, error });

    switch (type) {
      case "coincident":
        return pts.length === 2
          ? ok([makeConstraint("coincident", { points: [pts[0], pts[1]] })])
          : err("Select 2 points");

      case "horizontal":
      case "vertical":
        if (lines.length === 1) return ok([makeConstraint(type, { entities: [lines[0].id] })]);
        if (pts.length === 2) return ok([makeConstraint(type, { points: [pts[0], pts[1]] })]);
        return err("Select 1 line or 2 points");

      case "parallel":
      case "perpendicular":
        return lines.length === 2
          ? ok([makeConstraint(type, { entities: ids(lines) })])
          : err("Select 2 lines");

      case "equal":
        if (lines.length === 2) return ok([makeConstraint("equal", { entities: ids(lines) })]);
        if (circular.length === 2) return ok([makeConstraint("equal", { entities: ids(circular) })]);
        return err("Select 2 lines or 2 circles/arcs");

      case "concentric":
        return circular.length === 2
          ? ok([makeConstraint("concentric", { entities: ids(circular) })])
          : err("Select 2 circles/arcs");

      case "tangent": {
        if (lines.length === 1 && circular.length === 1)
          return ok([makeConstraint("tangent", { entities: [lines[0].id, circular[0].id] })]);
        if (circular.length === 2)
          return ok([makeConstraint("tangent", { entities: ids(circular) })]);
        return err("Select 1 line and 1 circle/arc, or 2 arcs/circles");
      }

      case "pointOnLine":
        return pts.length === 1 && lines.length === 1
          ? ok([makeConstraint("pointOnLine", { points: [pts[0]], entities: [lines[0].id] })])
          : err("Select 1 point and 1 line");

      case "pointOnArc":
        return pts.length === 1 && arcs.length === 1
          ? ok([makeConstraint("pointOnArc", { points: [pts[0]], entities: [arcs[0].id] })])
          : err("Select 1 point and 1 arc");

      case "midpoint":
        return pts.length === 1 && lines.length === 1
          ? ok([makeConstraint("midpoint", { points: [pts[0]], entities: [lines[0].id] })])
          : err("Select 1 point and 1 line");

      case "symmetric":
        return pts.length === 2 && lines.length === 1
          ? ok([makeConstraint("symmetric", { points: [pts[0], pts[1]], entities: [lines[0].id] })])
          : err("Select 2 points and 1 line (symmetry axis)");

      case "collinear":
        return lines.length === 2
          ? ok([makeConstraint("collinear", { entities: ids(lines) })])
          : err("Select 2 lines");

      case "fixed":
        return ents.length >= 1
          ? ok(ents.map((e) => makeConstraint("fixed", { entities: [e.id] })))
          : err("Select 1+ entities");
    }
  }
}
