/**
 * Selection + move tool.
 *   - click empty space + drag → marquee (L→R enclose, R→L crossing)
 *   - click an entity body       → select it; drag → move it (constraints reflow)
 *   - click a point handle        → select that point; drag → move just that point
 *   - shift                       → add/remove from the selection
 *
 * Moves go through the constraint solver: the dragged DOFs are "pinned" to the
 * cursor and the rest of the sketch is re-solved around them.
 */

import { Vec2, dist, sub } from "../core/vec2";
import { Bounds } from "../model/entities";
import { CADDocument } from "../model/document";
import { Constraint, constraintAnchor, PointRef, pointRefKey } from "../model/constraints";
import { PinMap } from "../solver/solver";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { Viewport } from "../view/viewport";

type Mode = "idle" | "maybeDragPoint" | "dragPoint" | "maybeDragEntity" | "dragEntity" | "marquee";

const DRAG_THRESHOLD_PX = 4;
const PICK_TOLERANCE_PX = 8;
const POINT_PICK_PX = 7;

export class SelectTool implements Tool {
  readonly id = "select";
  readonly label = "Select (V)";
  readonly icon = ICONS.select;

  private mode: Mode = "idle";
  private downScreen: Vec2 = { x: 0, y: 0 };
  private lastWorld: Vec2 = { x: 0, y: 0 };
  private dragPoint: PointRef | null = null;
  private marqueeStart: Vec2 = { x: 0, y: 0 };
  private marqueeEnd: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    this.downScreen = e.screen;
    this.lastWorld = e.worldRaw;

    // 1) Constraint badges and dimensions take priority for selection.
    const constraint = pickConstraintAt(ctx.doc, ctx.view, e.screen);
    if (constraint) {
      if (!e.shiftKey) {
        ctx.doc.selectConstraint(constraint.id);
      }
      this.mode = "idle";
      return;
    }

    const dim = ctx.doc.dimensionAt(e.worldRaw, ctx.view.toWorldLen(PICK_TOLERANCE_PX));
    if (dim) {
      if (!e.shiftKey) {
        ctx.doc.selectDimension(dim.id);
      }
      this.mode = "idle";
      return;
    }

    // 2) Point handles take priority over entity bodies.
    const pick = ctx.doc.pickPoint(e.worldRaw, ctx.view.toWorldLen(POINT_PICK_PX));
    if (pick) {
      if (e.shiftKey) {
        ctx.doc.togglePoint(pick.ref);
        this.mode = "idle";
      } else {
        if (!ctx.doc.isPointSelected(pick.ref)) {
          ctx.doc.clearSelection();
          ctx.doc.selectPoint(pick.ref);
        }
        this.dragPoint = pick.ref;
        this.mode = "maybeDragPoint";
        ctx.doc.emitChange();
      }
      return;
    }

    // 2) Entity body.
    const hit = ctx.doc.hitTest(e.worldRaw, ctx.view.toWorldLen(PICK_TOLERANCE_PX));
    if (hit) {
      if (e.shiftKey) {
        hit.selected = !hit.selected;
        this.mode = "idle";
      } else {
        if (!hit.selected) {
          ctx.doc.clearSelection();
          hit.selected = true;
        }
        this.mode = "maybeDragEntity";
      }
      ctx.doc.emitChange();
      return;
    }

    // 3) Marquee.
    if (!e.shiftKey) ctx.doc.clearSelection();
    this.mode = "marquee";
    this.marqueeStart = e.worldRaw;
    this.marqueeEnd = e.worldRaw;
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "maybeDragPoint" && dist(e.screen, this.downScreen) > DRAG_THRESHOLD_PX) {
      ctx.pushHistory();
      this.mode = "dragPoint";
    } else if (this.mode === "maybeDragEntity" && dist(e.screen, this.downScreen) > DRAG_THRESHOLD_PX) {
      ctx.pushHistory();
      this.mode = "dragEntity";
    }

    if (this.mode === "dragPoint" && this.dragPoint) {
      const pins: PinMap = new Map([[pointRefKey(this.dragPoint), e.world]]);
      ctx.solve(pins);
    } else if (this.mode === "dragEntity") {
      const d = sub(e.worldRaw, this.lastWorld);
      if (d.x !== 0 || d.y !== 0) {
        for (const ent of ctx.doc.selected) ent.translate(d);
        this.lastWorld = e.worldRaw;
        ctx.solve(pinsForSelected(ctx.doc));
      }
    } else if (this.mode === "marquee") {
      this.marqueeEnd = e.worldRaw;
      ctx.requestRender();
    }
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "marquee") {
      this.applyMarquee(ctx);
      ctx.requestRender();
    }
    this.mode = "idle";
    this.dragPoint = null;
  }

  getOverlay(): ToolOverlay {
    if (this.mode === "marquee") {
      return { previews: [], selectionRect: { a: this.marqueeStart, b: this.marqueeEnd } };
    }
    return { previews: [], selectionRect: null };
  }

  cancel(ctx: ToolContext): void {
    this.mode = "idle";
    this.dragPoint = null;
    ctx.requestRender();
  }

  private applyMarquee(ctx: ToolContext): void {
    const a = this.marqueeStart;
    const b = this.marqueeEnd;
    const crossing = b.x < a.x; // right-to-left = crossing
    const rect: Bounds = {
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    };
    for (const ent of ctx.doc.entities) {
      const eb = ent.bounds();
      const inside = crossing ? boundsIntersect(eb, rect) : boundsContainsBounds(rect, eb);
      if (inside) ent.selected = true;
    }
    ctx.doc.emitChange();
  }
}

function pinsForSelected(doc: CADDocument): PinMap {
  const m: PinMap = new Map();
  for (const ent of doc.selected) {
    for (const p of ent.dofPoints()) m.set(`${ent.id}:${p.key}`, p.pos);
  }
  return m;
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.max.x < b.min.x || a.min.x > b.max.x || a.max.y < b.min.y || a.min.y > b.max.y);
}
function boundsContainsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.min.x >= outer.min.x &&
    inner.max.x <= outer.max.x &&
    inner.min.y >= outer.min.y &&
    inner.max.y <= outer.max.y
  );
}

function pickConstraintAt(doc: CADDocument, view: Viewport, screen: Vec2): Constraint | null {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const geo = (id: string) => byId.get(id);
  const stack = new Map<string, number>();

  for (const c of doc.constraints) {
    const anchor = constraintAnchor(c, geo);
    if (!anchor) continue;
    const s = view.worldToScreen(anchor);
    const cellKey = `${Math.round(s.x / 16)},${Math.round(s.y / 16)}`;
    const n = stack.get(cellKey) ?? 0;
    stack.set(cellKey, n + 1);

    const bx = s.x + 10 + n * 16;
    const by = s.y - 10;
    const r = 7;

    const dx = screen.x - bx;
    const dy = screen.y - by;
    if (Math.hypot(dx, dy) <= r + 2) {
      return c;
    }
  }
  return null;
}
