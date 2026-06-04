import { Vec2, dist, sub } from "../core/vec2";
import { Bounds } from "../model/entities";
import { PointRef, pointRefKey, Constraint, constraintAnchor } from "../model/constraints";
import { CADDocument, DocSnapshot } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { Viewport } from "../view/viewport";
import { dimensionHitDistance, Dimension, dimensionLayout } from "../model/dimensions";
import { Geo } from "../model/constraints";
import { PinMap } from "../solver/solver";
import { selectionBounds, applyScale, applyRotate } from "../core/transform";
import { TransformBox, TransformHandle } from "../view/overlay";

type Mode = "idle" | "maybeDragPoint" | "dragPoint" | "maybeDragEntity" | "dragEntity" | "marquee" | "dragScale" | "dragRotate";

const DRAG_THRESHOLD_PX = 4;

export class SelectTool implements Tool {
  readonly id = "select";
  readonly label = "Select";
  readonly icon = `<path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2.9-3.2-7.4-4.4 4.7z"/>`;

  private mode: Mode = "idle";
  private downScreen: Vec2 = { x: 0, y: 0 };
  private dragPoint: PointRef | null = null;
  private lastWorld: Vec2 = { x: 0, y: 0 };
  private marqueeStart: Vec2 = { x: 0, y: 0 };
  private marqueeEnd: Vec2 = { x: 0, y: 0 };

  private dragSnapshot: DocSnapshot | null = null;
  private originalBounds: Bounds | null = null;
  private activeHandleId: string | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return; // Left click only

    this.downScreen = e.screen;
    this.lastWorld = e.worldRaw;

    // 0) Hit test transform handles first
    if (ctx.doc.selected.length > 0) {
      const box = this.getTransformBox(ctx);
      if (box) {
        let hitHandle: TransformHandle | null = null;
        for (const h of box.handles) {
          if (dist(e.screen, ctx.view.worldToScreen(h.pos)) <= 10) {
            hitHandle = h;
            break;
          }
        }
        if (hitHandle) {
          ctx.pushHistory();
          this.dragSnapshot = ctx.doc.snapshot();
          this.originalBounds = box.bounds;
          this.activeHandleId = hitHandle.id;
          this.mode = hitHandle.type === "scale" ? "dragScale" : "dragRotate";
          return;
        }
      }
    }

    // 1) Point / constraint handles
    let hitPoint: PointRef | null = null;
    let hitDist = Infinity;
    for (const ent of ctx.doc.entities) {
      if (ctx.doc.groupOf(ent.id)) continue; // ignore points for grouped entities
      for (const p of ent.dofPoints()) {
        const d = dist(e.screen, ctx.view.worldToScreen(p.pos));
        if (d < 10 && d < hitDist) {
          hitPoint = { entityId: ent.id, key: p.key };
          hitDist = d;
        }
      }
    }

    if (hitPoint) {
      const ent = ctx.doc.entities.find((x) => x.id === hitPoint!.entityId);
      if (!ent?.selected && !e.shiftKey) {
        ctx.doc.clearSelection();
        ent!.selected = true;
        ctx.doc.emitChange();
      }
      this.mode = "maybeDragPoint";
      this.dragPoint = hitPoint;
      return;
    }

    // Constraints & Dimensions
    const hitConstraint = pickConstraintAt(ctx.doc, ctx.view, e.screen);
    if (hitConstraint) {
      ctx.doc.selectedConstraintId = hitConstraint.id;
      ctx.doc.emitChange();
      return;
    }

    let hitDim: Dimension | null = null;
    let dimDist = Infinity;
    const byId = new Map(ctx.doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id: string) => byId.get(id);

    for (const dim of ctx.doc.dimensions) {
      const layout = dimensionLayout(dim, geo, ctx.doc.displayUnit);
      if (!layout) continue;
      const hitDist = dimensionHitDistance(dim, geo, e.worldRaw, ctx.doc.displayUnit) * ctx.view.scale;
      if (hitDist < 15 && hitDist < dimDist) {
        hitDim = dim;
        dimDist = hitDist;
      }
    }
    if (hitDim) {
      ctx.doc.selectedDimensionId = hitDim.id;
      ctx.doc.emitChange();
      return;
    }

    // 2) Entity bodies
    let hitEntId: string | null = null;
    let entDist = Infinity;
    for (const ent of ctx.doc.entities) {
      const d = ent.distanceTo(e.worldRaw);
      const px = d * ctx.view.scale;
      if (px < 10 && px < entDist) {
        hitEntId = ent.id;
        entDist = px;
      }
    }

    if (hitEntId) {
      const ent = ctx.doc.entities.find((x) => x.id === hitEntId)!;
      const group = ctx.doc.groupOf(ent.id);

      if (e.shiftKey) {
        if (group) {
          const groupSelected = group.entityIds.every(id => ctx.doc.entities.find(e => e.id === id)?.selected);
          for (const id of group.entityIds) {
            const ge = ctx.doc.entities.find(x => x.id === id);
            if (ge) ge.selected = !groupSelected;
          }
        } else {
          ent.selected = !ent.selected;
        }
      } else {
        if (!ent.selected) {
          ctx.doc.clearSelection();
          if (group) {
            for (const id of group.entityIds) {
              const ge = ctx.doc.entities.find(x => x.id === id);
              if (ge) ge.selected = true;
            }
          } else {
            ent.selected = true;
          }
        }
      }
      ctx.doc.emitChange();
      this.mode = "maybeDragEntity";
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
    } else if (this.mode === "dragScale" && this.dragSnapshot && this.originalBounds) {
      ctx.doc.restore(this.dragSnapshot); // resets entities
      
      const ob = this.originalBounds;
      const id = this.activeHandleId!;
      
      let cx = (ob.min.x + ob.max.x) / 2;
      let cy = (ob.min.y + ob.max.y) / 2;

      if (!e.altKey) {
        if (id.includes("n")) cy = ob.min.y;
        else if (id.includes("s")) cy = ob.max.y;
        
        if (id.includes("e")) cx = ob.min.x;
        else if (id.includes("w")) cx = ob.max.x;
      }

      let sx = 1, sy = 1;
      let origDx = 0, origDy = 0;
      
      if (id.includes("e")) origDx = ob.max.x - cx;
      else if (id.includes("w")) origDx = ob.min.x - cx;
      
      if (id.includes("n")) origDy = ob.max.y - cy;
      else if (id.includes("s")) origDy = ob.min.y - cy;
      
      const curDx = e.worldRaw.x - cx;
      const curDy = e.worldRaw.y - cy;
      
      if (origDx !== 0) sx = curDx / origDx;
      if (origDy !== 0) sy = curDy / origDy;
      
      if (id === "n" || id === "s") sx = 1;
      if (id === "e" || id === "w") sy = 1;
      
      if (e.shiftKey) {
        let maxAbs = Math.max(Math.abs(sx), Math.abs(sy));
        if (id === "n" || id === "s") sx = maxAbs * Math.sign(sx); // wait, for N/S shift shouldn't constrain width if it's 1
        if (id !== "n" && id !== "s" && id !== "e" && id !== "w") {
          sx = maxAbs * Math.sign(sx);
          sy = maxAbs * Math.sign(sy);
        }
      }
      
      if (Math.abs(sx) > 0.001 || Math.abs(sy) > 0.001) {
        applyScale(ctx.doc.selected, cx, cy, sx, sy);
      }
      
      ctx.solve();
    } else if (this.mode === "dragRotate" && this.dragSnapshot && this.originalBounds) {
      ctx.doc.restore(this.dragSnapshot);
      const ob = this.originalBounds;
      const cx = (ob.min.x + ob.max.x) / 2;
      const cy = (ob.min.y + ob.max.y) / 2;
      
      const startAngle = Math.PI / 2; // "n" direction in standard atan2
      const currentAngle = Math.atan2(e.worldRaw.y - cy, e.worldRaw.x - cx);
      const angle = currentAngle - startAngle;
      
      applyRotate(ctx.doc.selected, cx, cy, angle);
      ctx.solve();
    }
  }

  onDoubleClick(e: ToolPointerEvent, ctx: ToolContext): void {
    let hitEntId: string | null = null;
    let entDist = Infinity;
    for (const ent of ctx.doc.entities) {
      const d = ent.distanceTo(e.worldRaw);
      const px = d * ctx.view.scale;
      if (px < 10 && px < entDist) {
        hitEntId = ent.id;
        entDist = px;
      }
    }

    if (!hitEntId) return;

    // Chain select: find all connected entities
    const toSelect = new Set<string>();
    const queue = [hitEntId];
    toSelect.add(hitEntId);

    const EPS = 1e-6;

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentEnt = ctx.doc.entities.find(e => e.id === currentId);
      if (!currentEnt) continue;

      const currentPts = currentEnt.dofPoints().map(p => p.pos);

      for (const other of ctx.doc.entities) {
        if (toSelect.has(other.id)) continue;
        const otherPts = other.dofPoints().map(p => p.pos);
        
        let connected = false;
        for (const p1 of currentPts) {
          for (const p2 of otherPts) {
            if (dist(p1, p2) < EPS) {
              connected = true;
              break;
            }
          }
          if (connected) break;
        }

        if (connected) {
          toSelect.add(other.id);
          queue.push(other.id);
        }
      }
    }

    // Select them all
    if (!e.shiftKey) ctx.doc.clearSelection();
    for (const ent of ctx.doc.entities) {
      if (toSelect.has(ent.id)) {
        ent.selected = true;
        // Also select the whole group if part of a group
        const group = ctx.doc.groupOf(ent.id);
        if (group) {
          for (const id of group.entityIds) {
            const ge = ctx.doc.entities.find(x => x.id === id);
            if (ge) ge.selected = true;
          }
        }
      }
    }
    ctx.doc.emitChange();
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "marquee") {
      this.applyMarquee(ctx);
    } else if (this.mode === "dragScale" || this.mode === "dragRotate") {
      ctx.doc.emitChange(); // Ensure properties panel updates at end of drag
    }
    
    this.mode = "idle";
    this.dragPoint = null;
    this.dragSnapshot = null;
    this.originalBounds = null;
    this.activeHandleId = null;
    ctx.requestRender();
  }

  getOverlay(ctx?: ToolContext): ToolOverlay {
    if (this.mode === "marquee") {
      return { previews: [], selectionRect: { a: this.marqueeStart, b: this.marqueeEnd } };
    }
    if (ctx && ctx.doc.selected.length > 0 && this.mode !== "dragPoint" && this.mode !== "maybeDragPoint") {
      return { previews: [], selectionRect: null, transformBox: this.getTransformBox(ctx) };
    }
    return { previews: [], selectionRect: null };
  }

  cancel(ctx: ToolContext): void {
    this.mode = "idle";
    this.dragPoint = null;
    this.dragSnapshot = null;
    this.originalBounds = null;
    this.activeHandleId = null;
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
    
    const toSelect = new Set<string>();
    for (const ent of ctx.doc.entities) {
      const eb = ent.bounds();
      const inside = crossing ? boundsIntersect(eb, rect) : boundsContainsBounds(rect, eb);
      if (inside) {
        const group = ctx.doc.groupOf(ent.id);
        if (group) {
          for (const id of group.entityIds) toSelect.add(id);
        } else {
          toSelect.add(ent.id);
        }
      }
    }
    
    for (const ent of ctx.doc.entities) {
      if (toSelect.has(ent.id)) ent.selected = true;
    }
    ctx.doc.emitChange();
  }

  private getTransformBox(ctx: ToolContext): TransformBox | null {
    if (ctx.doc.selected.length === 0) return null;
    const bounds = selectionBounds(ctx.doc.selected);
    if (!bounds) return null;

    const { min, max } = bounds;
    const cx = (min.x + max.x) / 2;
    const cy = (min.y + max.y) / 2;

    const handles: TransformHandle[] = [
      { id: "nw", type: "scale", pos: { x: min.x, y: max.y } },
      { id: "n", type: "scale", pos: { x: cx, y: max.y } },
      { id: "ne", type: "scale", pos: { x: max.x, y: max.y } },
      { id: "e", type: "scale", pos: { x: max.x, y: cy } },
      { id: "se", type: "scale", pos: { x: max.x, y: min.y } },
      { id: "s", type: "scale", pos: { x: cx, y: min.y } },
      { id: "sw", type: "scale", pos: { x: min.x, y: min.y } },
      { id: "w", type: "scale", pos: { x: min.x, y: cy } },
      { id: "rot", type: "rotate", pos: { x: cx, y: max.y + ctx.view.toWorldLen(24) } } 
    ];

    return { bounds, handles };
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
