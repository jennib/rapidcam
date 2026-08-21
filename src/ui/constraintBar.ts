/**
 * Constraints toolbar. Each button applies a constraint to the CURRENT selection
 * (whole entities via entity-select, point DOFs via point-select), then triggers
 * a solve. Buttons enable/disable based on whether the selection fits the type.
 */

import { CONSTRAINT_ICONS } from "./constraintIcons";
import { dist } from "../core/vec2";
import {
  CONSTRAINT_LABELS,
  type Constraint,
  type ConstraintType,
  type Geo,
  lineRefEntityId,
  makeConstraint,
  measureAngleBetweenLines,
  resolveLineGeom,
  segmentRef,
  seedConstraintPoints,
  tangentContactOutsideArcSweep,
} from "../model/constraints";
import { type CADDocument, STOCK_ENTITY_ID } from "../model/document";
import { type CircleEntity, type Entity, type LineEntity, PolylineEntity } from "../model/entities";
import { constraintJacobianRankChange, type SolveResult } from "../solver/solver";

interface ButtonSpec {
  type: ConstraintType;
  hint: string;
}

const BUTTONS: (ButtonSpec | "sep")[] = [
  { type: "coincident", hint: "Select 2 points, or 1 circle + 1 line" },
  "sep",
  { type: "horizontal", hint: "Select 1 line or 2 points" },
  { type: "vertical", hint: "Select 1 line or 2 points" },
  "sep",
  { type: "parallel", hint: "Select 2 lines" },
  { type: "perpendicular", hint: "Select 2 lines" },
  { type: "equal", hint: "Select 2 lines or 2 circles" },
  "sep",
  { type: "concentric", hint: "Select 2 circles" },
  { type: "tangent", hint: "Select 1 line and 1 circle/arc, or 2 arcs/circles" },
  { type: "pointOnLine", hint: "Select 1 point and 1 line" },
  { type: "pointOnArc", hint: "Select 1 point and 1 arc" },
  {
    type: "midpoint",
    hint: "Select 1 point and 1 line, or 3 points (first = midpoint)",
  },
  "sep",
  { type: "symmetric", hint: "Select 2 points and 1 line (symmetry axis)" },
  { type: "collinear", hint: "Select 2 lines" },
  "sep",
  { type: "pointOnCircle", hint: "Select 1 point and 1 circle" },
  { type: "angle", hint: "Select 2 lines (locks current angle)" },
  { type: "fixedPoint", hint: "Select 1+ points to lock in place" },
  "sep",
  { type: "fixed", hint: "Select 1+ entities to lock in place" },
];

type BuildResult = { ok: true; constraints: Constraint[] } | { ok: false; error: string };

/** Validate the current selection for `type` and, if valid, produce constraints. */
export function buildConstraintsFor(type: ConstraintType, doc: CADDocument): BuildResult {
  const ents = doc.selected;
  const lines = ents.filter((e) => e.type === "line");
  const circles = ents.filter((e) => e.type === "circle");
  const arcs = ents.filter((e) => e.type === "arc");
  const circular = [...circles, ...arcs];
  const stockPts = doc.selectedPoints.filter((p) => p.entityId === STOCK_ENTITY_ID);
  const pts = doc.selectedPoints.filter((p) => p.entityId !== STOCK_ENTITY_ID);
  const ids = (es: Entity[]) => es.map((e) => e.id);

  // Line-like references for line-type constraints: whole LineEntities PLUS any
  // selected polyline segments (encoded as `${polylineId}#${index}`) OR stock edges.
  const lineRefs: string[] = [
    ...lines.map((l) => l.id),
    ...doc.selectedSegments.map((s) => {
      // Encode the segment by its START vertex's stable id, so the constraint
      // survives later edits that renumber vertices.
      const poly = doc.entities.find((e) => e.id === s.entityId);
      const startId = poly instanceof PolylineEntity ? poly.vertexIds[s.index] : String(s.index);
      return segmentRef(s.entityId, startId);
    }),
  ];

  for (const sp of stockPts) {
    if (sp.key === "mid_l" || sp.key === "bl" || sp.key === "tl")
      lineRefs.push(`${STOCK_ENTITY_ID}#left`);
    else if (sp.key === "mid_r" || sp.key === "br" || sp.key === "tr")
      lineRefs.push(`${STOCK_ENTITY_ID}#right`);
    else if (sp.key === "mid_t") lineRefs.push(`${STOCK_ENTITY_ID}#top`);
    else if (sp.key === "mid_b") lineRefs.push(`${STOCK_ENTITY_ID}#bottom`);
  }

  const ok = (constraints: Constraint[]): BuildResult => ({ ok: true, constraints });
  const err = (error: string): BuildResult => ({ ok: false, error });

  switch (type) {
    case "coincident":
      if (pts.length === 2) return ok([makeConstraint("coincident", { points: [pts[0], pts[1]] })]);
      if (circles.length === 1 && lines.length === 1) {
        const circ = circles[0] as CircleEntity;
        const line = lines[0] as LineEntity;
        const key = dist(circ.center, line.a) <= dist(circ.center, line.b) ? "a" : "b";
        return ok([
          makeConstraint("coincident", {
            points: [
              { entityId: circ.id, key: "c" },
              { entityId: line.id, key },
            ],
          }),
        ]);
      }
      return err("Select 2 points, or 1 circle + 1 line");

    case "horizontal":
    case "vertical":
      if (lineRefs.length === 1) return ok([makeConstraint(type, { entities: [lineRefs[0]] })]);
      if (pts.length === 2) return ok([makeConstraint(type, { points: [pts[0], pts[1]] })]);
      return err("Select 1 line/segment or 2 points");

    case "parallel":
    case "perpendicular":
      return lineRefs.length === 2
        ? ok([makeConstraint(type, { entities: lineRefs })])
        : err("Select 2 lines/segments");

    case "equal":
      if (lineRefs.length === 2) return ok([makeConstraint("equal", { entities: lineRefs })]);
      if (circular.length === 2) return ok([makeConstraint("equal", { entities: ids(circular) })]);
      return err("Select 2 lines/segments or 2 circles/arcs");

    case "concentric":
      return circular.length === 2
        ? ok([makeConstraint("concentric", { entities: ids(circular) })])
        : err("Select 2 circles/arcs");

    case "tangent": {
      if (lineRefs.length === 1 && circular.length === 1)
        return ok([makeConstraint("tangent", { entities: [lineRefs[0], circular[0].id] })]);
      if (circular.length === 2)
        return ok([makeConstraint("tangent", { entities: ids(circular) })]);
      return err("Select 1 line/segment and 1 circle/arc, or 2 arcs/circles");
    }

    case "pointOnLine": {
      const targetLines =
        pts.length === 1
          ? lineRefs.filter((l) => lineRefEntityId(l) !== pts[0].entityId)
          : lineRefs;
      return pts.length === 1 && targetLines.length === 1
        ? ok([makeConstraint("pointOnLine", { points: [pts[0]], entities: [targetLines[0]] })])
        : err("Select 1 point and 1 line/segment");
    }

    case "pointOnArc":
      return pts.length === 1 && arcs.length === 1
        ? ok([makeConstraint("pointOnArc", { points: [pts[0]], entities: [arcs[0].id] })])
        : err("Select 1 point and 1 arc");

    case "midpoint": {
      const targetLines =
        pts.length === 1
          ? lineRefs.filter((l) => lineRefEntityId(l) !== pts[0].entityId)
          : lineRefs;
      if (pts.length === 1 && targetLines.length === 1)
        return ok([makeConstraint("midpoint", { points: [pts[0]], entities: [targetLines[0]] })]);
      // Two-point variant: the first selected point becomes the midpoint of
      // the other two (e.g. circle centre + two opposite rectangle corners).
      if (pts.length === 3 && ents.length === 0)
        return ok([makeConstraint("midpoint", { points: [pts[0], pts[1], pts[2]] })]);
      return err("Select 1 point and 1 line, or 3 points (first selected = midpoint)");
    }

    case "symmetric":
      return pts.length === 2 && lineRefs.length === 1
        ? ok([makeConstraint("symmetric", { points: [pts[0], pts[1]], entities: [lineRefs[0]] })])
        : err("Select 2 points and 1 line/segment (symmetry axis)");

    case "collinear":
      return lineRefs.length === 2
        ? ok([makeConstraint("collinear", { entities: lineRefs })])
        : err("Select 2 lines/segments");

    case "pointOnCircle":
      return pts.length === 1 && circles.length === 1
        ? ok([makeConstraint("pointOnCircle", { points: [pts[0]], entities: [circles[0].id] })])
        : err("Select 1 point and 1 circle");

    case "angle": {
      if (lineRefs.length !== 2) return err("Select 2 lines/segments");
      const byId = new Map(doc.entities.map((e) => [e.id, e]));
      const geo: Geo = (id) => byId.get(id);
      const g1 = resolveLineGeom(geo, lineRefs[0]);
      const g2 = resolveLineGeom(geo, lineRefs[1]);
      if (!g1 || !g2) return err("Select 2 lines/segments");
      const angle = measureAngleBetweenLines(g1, g2);
      return ok([makeConstraint("angle", { entities: lineRefs, params: [angle] })]);
    }

    case "fixedPoint": {
      if (pts.length < 1) return err("Select 1+ points");
      const constraints: Constraint[] = [];
      for (const pt of pts) {
        const ent = doc.entities.find((e) => e.id === pt.entityId);
        if (!ent) continue;
        try {
          const pos = ent.getPoint(pt.key);
          constraints.push(makeConstraint("fixedPoint", { points: [pt], params: [pos.x, pos.y] }));
        } catch {
          /* skip invalid point refs */
        }
      }
      return constraints.length > 0 ? ok(constraints) : err("Select 1+ points");
    }

    case "fixed":
      return ents.length >= 1
        ? ok(ents.map((e) => makeConstraint("fixed", { entities: [e.id] })))
        : err("Select 1+ entities");

    case "center":
      // Not creatable from the Constraints bar — it's emitted by the Center /
      // Align command (which knows the mover and reference). Kept for exhaustiveness.
      return err("Use the Center command (right-click or Align tools)");
  }
}

export class ConstraintBar {
  private typeButtons: { spec: ButtonSpec; el: HTMLButtonElement }[] = [];
  private msgEl!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private onSolve: () => SolveResult | null,
    private pushHistory: () => void,
    private undo: () => void,
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
      btn.innerHTML = CONSTRAINT_ICONS[b.type];
      btn.title = `${CONSTRAINT_LABELS[b.type]} — ${b.hint}`;
      btn.setAttribute("aria-label", CONSTRAINT_LABELS[b.type]);
      btn.addEventListener("click", () => this.apply(b));
      this.host.appendChild(btn);
      this.typeButtons.push({ spec: b, el: btn });
    }

    const sep = document.createElement("div");
    sep.className = "cb-sep";
    this.host.appendChild(sep);

    this.msgEl = document.createElement("span");
    this.msgEl.className = "cb-msg";
    this.host.appendChild(this.msgEl);
  }

  private apply(spec: ButtonSpec): void {
    const res = buildConstraintsFor(spec.type, this.doc);
    if (!res.ok) {
      this.message(res.error, "error");
      return;
    }

    // Seed mover points onto reference targets so starting residual is satisfied
    // and reference geometry doesn't drift or distort existing dimensions.
    seedConstraintPoints(this.doc, res.constraints);

    // Rank-based check: compute how much the Jacobian rank actually increases.
    // This correctly handles redundant constraints (rank stays the same even
    // though the equation count grows) and over-constraining ones.
    const { variables, rankWithout, rankWith } = constraintJacobianRankChange(
      this.doc,
      res.constraints,
    );
    const rankIncrease = rankWith - rankWithout;
    const effectiveDof = variables - rankWithout;

    if (rankIncrease === 0) {
      this.message("Constraint already implied by existing constraints", "error");
      return;
    }
    if (rankIncrease > effectiveDof) {
      this.message(
        `Would over-constrain (${effectiveDof} DOF free, constraint adds ${rankIncrease})`,
        "error",
      );
      return;
    }

    this.pushHistory();
    for (const c of res.constraints) this.doc.addConstraint(c);
    this.doc.clearSelection();
    const solveRes = this.onSolve();

    if (solveRes && !solveRes.converged) {
      this.undo();
      this.message("Constraint conflicts or over-constrains the sketch", "error");
      return;
    }

    // Non-blocking warning: a line↔arc tangent whose contact point falls outside
    // the arc's sweep is valid but the visible arc won't actually touch the line.
    const geo: Geo = (() => {
      const m = new Map(this.doc.entities.map((e) => [e.id, e]));
      return (id) => m.get(id);
    })();
    if (res.constraints.some((c) => tangentContactOutsideArcSweep(c, geo))) {
      this.message("Added tangent — ⚠ contact point lies outside the arc's sweep", "warn");
      return;
    }

    this.message(`Added ${CONSTRAINT_LABELS[spec.type].toLowerCase()}`, "ok");
  }

  private refresh(): void {
    const hasSelection = this.doc.selected.length > 0 || this.doc.selectedPoints.length > 0;
    for (const { spec, el } of this.typeButtons) {
      el.disabled = !buildConstraintsFor(spec.type, this.doc).ok;
    }
    // No standing "select something" hint: the buttons are already disabled,
    // which says the same thing without occupying a line. The element stays —
    // it still carries real messages (errors, "Added coincident") — but it is
    // cleared when the selection goes away so a message about geometry you are
    // no longer holding cannot linger.
    if (!hasSelection) {
      this.msgEl.textContent = "";
      this.msgEl.className = "cb-msg";
    }
  }

  private message(text: string, kind: "error" | "ok" | "warn"): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `cb-msg ${kind}`;
  }
}
