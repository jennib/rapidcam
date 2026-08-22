/**
 * Chamfer tool: click or drag a corner to bevel it.
 *
 * Drag away from the corner for a live preview — release to commit.
 * Click without dragging to type an exact distance instead.
 * Works on line-line corners, rectangle corners and polyline / polygon vertices.
 *
 * A rectangle or a polyline keeps its corner as an editable SETBACK on the
 * entity; only a pair of loose lines gets surgery (a bevel line inserted, the
 * two legs trimmed). See the fillet tool's header — the two are the same story.
 */

import { type Vec2, dist } from "../core/vec2";
import { LineEntity } from "../model/entities";
import type { CADDocument } from "../model/document";
import type { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { parseLength, formatLengthWithUnit } from "../core/units";
import type { Unit } from "../core/units";
import type { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";
import {
  CORNER_EPS,
  DRAG_THRESHOLD_PX,
  type Corner,
  type CornerDirs,
  cornerAngle,
  cornerValueFits,
  dropCornerJoin,
  findCorner,
  getCornerDirs,
  joinCornerEnds,
  reportRetype,
  setRectCorner,
  setPolyCorner,
  trimCornerLegs,
} from "./corner";

interface ChamferGeo {
  T1: Vec2;
  T2: Vec2;
}

type Phase = "idle" | "dragging";

// ---------------------------------------------------------------------------
// Geometry — the straight bevel across both legs. Corner picking and the
// surgery around this live in ./corner.ts, shared with the fillet tool.
// ---------------------------------------------------------------------------

function computeGeo(dirs: CornerDirs, d: number): ChamferGeo | null {
  const { P, d1, len1, d2, len2 } = dirs;
  if (cornerAngle(dirs) === null) return null;
  if (d <= 0 || d >= len1 - CORNER_EPS || d >= len2 - CORNER_EPS) return null;
  return {
    T1: { x: P.x + d * d1.x, y: P.y + d * d1.y },
    T2: { x: P.x + d * d2.x, y: P.y + d * d2.y },
  };
}

function buildPreviews(corner: Corner, value: number, unit: Unit): PreviewShape[] {
  const base: PreviewShape = { kind: "point", pos: corner.pos };
  if (value <= 0) return [base];
  // A rectangle's neighbouring corner can veto a setback its own legs allow.
  if (!cornerValueFits(corner, value)) return [base];
  const dirs = getCornerDirs(corner);
  if (!dirs) return [base];
  const geo = computeGeo(dirs, value);
  if (!geo) return [base];
  return [
    base,
    { kind: "line", a: geo.T1, b: geo.T2 },
    { kind: "text", pos: corner.pos, text: formatLengthWithUnit(value, unit), dx: 12, dy: -12 },
  ];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Bevel one corner. Returns false when the corner cannot take this setback, so
 * the caller can say so rather than appearing to do nothing.
 */
function applyChamfer(corner: Corner, distance: number, doc: CADDocument): boolean {
  // Rectangles and polylines keep their corners as a property — nothing is cut,
  // replaced or spliced, and the setback stays editable in Properties.
  if (corner.kind === "rect") return setRectCorner(corner, distance, "chamfer");
  if (corner.kind === "poly") return setPolyCorner(corner, distance, "chamfer");

  const dirs = getCornerDirs(corner);
  if (!dirs) return false;
  const geo = computeGeo(dirs, distance);
  if (!geo) return false;

  trimCornerLegs(corner, geo.T1, geo.T2);
  dropCornerJoin(doc, corner);

  const chamfer = new LineEntity(geo.T1, geo.T2);
  doc.add(chamfer);
  joinCornerEnds(doc, corner, chamfer.id, "a", "b", "chamfer");

  return true;
}

/**
 * Whether this setback can be committed here — the same test the preview draws
 * from, so what is shown and what is accepted cannot disagree — and, when it
 * cannot, WHY. See the fillet tool's `check`: the message that existed sat
 * behind this test and could never fire. A non-positive distance gets no
 * message; that is an empty gesture, not a refusal.
 */
function check(corner: Corner, distance: number): { ok: boolean; why?: string } {
  if (distance < 0) return { ok: false };
  // A typed zero is AutoCAD's "make this corner sharp", not a non-answer. A
  // rectangle or polyline keeps its corner as a stored value, so clearing it is
  // exactly that. A pair of loose lines was surgery — the arc is its own entity
  // now — so there is nothing here for a zero to clear, and saying so beats a
  // field that swallows what you typed. Callers that mean "no gesture" (a drag
  // that went nowhere) filter the value before asking.
  if (distance === 0) {
    return corner.kind === "line"
      ? { ok: false, why: "These lines are already bevelled — undo, or delete the arc." }
      : { ok: true };
  }
  if (!cornerValueFits(corner, distance))
    // Accurate whether or not the neighbour is rounded: the test is
    // `this + neighbour <= edge`, and a square neighbour contributes zero.
    return {
      ok: false,
      why: "That distance won't fit — each edge has to hold this corner and the one next to it.",
    };
  const dirs = getCornerDirs(corner);
  if (!dirs || !computeGeo(dirs, distance))
    return { ok: false, why: "That distance is bigger than the lines it has to fit between." };
  return { ok: true };
}

/** Bevel the corner, saying so when it could not take the setback. */
function commit(corner: Corner, distance: number, ctx: ToolContext): void {
  // Said BEFORE applying, while the rectangle still holds the old type.
  reportRetype(corner, "chamfer", ctx);
  if (!applyChamfer(corner, distance, ctx.doc))
    ctx.notify("That distance is too big for this corner.");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ChamferTool implements Tool {
  readonly id = "chamfer";
  readonly label = "Chamfer";
  readonly icon = ICONS.chamfer;

  private phase: Phase = "idle";
  private hoverCorner: Corner | null = null;
  private activeCorner: Corner | null = null;
  private downScreen: Vec2 = { x: 0, y: 0 };
  private currentValue = 0;
  private previews: PreviewShape[] = [];

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.phase === "idle") {
      const c = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
      if (c?.pos !== this.hoverCorner?.pos) {
        this.hoverCorner = c;
        ctx.requestRender();
      }
      return;
    }
    const corner = this.activeCorner!;
    const d = dist(e.worldRaw, corner.pos);
    this.currentValue = d;
    this.previews = buildPreviews(corner, d, ctx.doc.displayUnit);
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const corner = findCorner(e.worldRaw, ctx.doc, ctx.view.scale);
    if (!corner) return;
    this.phase = "dragging";
    this.activeCorner = corner;
    this.downScreen = { ...e.screen };
    this.currentValue = 0;
    this.previews = [{ kind: "point", pos: corner.pos }];
    ctx.requestRender();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.phase !== "dragging" || !this.activeCorner) return;
    const corner = this.activeCorner;
    const screenDelta = dist(e.screen, this.downScreen);
    this.reset(ctx);

    if (screenDelta < DRAG_THRESHOLD_PX) {
      // A click rather than a drag — ask for the exact distance (Type to Draw).
      ctx.openTypeToDraw(
        corner.pos,
        [{ placeholder: `Chamfer distance (${ctx.doc.displayUnit})` }],
        {
          onCommit: (raws) => {
            const d = parseLength((raws[0] ?? "").trim(), ctx.doc.displayUnit);
            if (d === null || d < 0) return false;
            const v = check(corner, d);
            if (!v.ok) {
              if (v.why) ctx.notify(v.why);
              return false;
            }
            ctx.pushHistory();
            commit(corner, d, ctx);
            ctx.solve();
            ctx.doc.emitChange();
          },
          onCancel: () => {},
        },
      );
    } else {
      // drag commit. A drag that ended back at zero asked for nothing, so it
      // is filtered here rather than inside `check` — where a typed zero is a
      // real request to clear the corner.
      if (this.currentValue <= 0) return;
      const v = check(corner, this.currentValue);
      if (v.ok) {
        ctx.pushHistory();
        commit(corner, this.currentValue, ctx);
        ctx.solve();
        ctx.doc.emitChange();
      } else if (v.why) {
        ctx.notify(v.why);
      }
    }
  }

  private reset(ctx: ToolContext): void {
    this.phase = "idle";
    this.activeCorner = null;
    this.previews = [];
    ctx.requestRender();
  }

  cancel(ctx: ToolContext): void {
    this.reset(ctx);
    this.hoverCorner = null;
  }

  getOverlay(): ToolOverlay {
    if (this.phase === "dragging") return { previews: this.previews, selectionRect: null };
    if (this.hoverCorner)
      return { previews: [{ kind: "point", pos: this.hoverCorner.pos }], selectionRect: null };
    return { previews: [], selectionRect: null };
  }
}
