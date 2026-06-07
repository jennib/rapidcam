import { Vec2, dist, sub } from "../core/vec2";
import { Bounds, LineEntity, TextEntity } from "../model/entities";
import { PointRef, pointRefKey, Constraint, constraintAnchors, ConstraintType } from "../model/constraints";
import { CADDocument, DocSnapshot } from "../model/document";
import { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";
import { Viewport } from "../view/viewport";
import { dimensionHitDistance, dimensionOffsetFromCursor, Dimension, dimensionLayout } from "../model/dimensions";
import { Geo } from "../model/constraints";
import { PinMap } from "../solver/solver";
import { selectionBounds, applyScale, applyRotate } from "../core/transform";
import { TransformBox, TransformHandle } from "../view/overlay";
import { ICONS } from "./icons";
import { buildConstraintsFor } from "../ui/constraintBar";
import { openTextDialog } from "../ui/textEditDialog";

const CONSTRAINT_KEYS: Record<string, ConstraintType> = {
  h: "horizontal",
  v: "vertical",
  e: "equal",
  p: "parallel",
  k: "perpendicular",
  c: "coincident",
};

function isEntityFixed(doc: CADDocument, id: string): boolean {
  return doc.constraints.some(c => c.type === "fixed" && c.entities.includes(id));
}

type Mode = "idle" | "maybeDragPoint" | "dragPoint" | "maybeDragEntity" | "dragEntity" | "marquee" | "dragScale" | "dragRotate" | "maybeDragDimLabel" | "dragDimLabel";

const DRAG_THRESHOLD_PX = 4;

export class SelectTool implements Tool {
  readonly id = "select";
  readonly label = "Select";
  readonly icon = ICONS.select;

  private mode: Mode = "idle";
  private downScreen: Vec2 = { x: 0, y: 0 };
  private dragStartWorld: Vec2 = { x: 0, y: 0 };
  private dragPoint: PointRef | null = null;
  private marqueeStart: Vec2 = { x: 0, y: 0 };
  private marqueeEnd: Vec2 = { x: 0, y: 0 };

  private dragSnapshot: DocSnapshot | null = null;
  private originalBounds: Bounds | null = null;
  private activeHandleId: string | null = null;
  private dragDimLabelId: string | null = null;
  private pickedEntId: string | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return; // Left click only

    this.downScreen = e.screen;
    this.dragStartWorld = e.worldRaw;

    // 0) Ctrl+click: point selection for constraint application.
    //    Works on any entity (selected or not) — adds the entity to selection
    //    and toggles the point in doc.selectedPoints.
    //    Always returns early so a miss never falls through to entity-body
    //    selection, which would wipe selectedPoints via clearSelection().
    if (e.ctrlKey) {
      let bestRef: PointRef | null = null;
      let bestD = Infinity;
      for (const ent of ctx.doc.entities) {
        if (ctx.doc.groupOf(ent.id)) continue;
        for (const p of ent.pickablePoints()) {
          const d = dist(e.screen, ctx.view.worldToScreen(p.pos));
          if (d < 14 && d < bestD) { bestRef = { entityId: ent.id, key: p.key }; bestD = d; }
        }
      }
      if (bestRef) {
        const ent = ctx.doc.entities.find(x => x.id === bestRef!.entityId)!;
        if (!ent.selected) ent.selected = true;
        ctx.doc.togglePoint(bestRef);
      }
      return;
    }

    // 1) Hit test transform handles first
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

    // 1) Point / constraint handles — only for already-selected entities so that
    //    coincident points on unselected entities don't shadow body hit-tests.
    let hitPoint: PointRef | null = null;
    let hitDist = Infinity;
    for (const ent of ctx.doc.entities) {
      if (!ent.selected) continue;
      if (ctx.doc.groupOf(ent.id)) continue;
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

    const byId = new Map(ctx.doc.entities.map((e) => [e.id, e]));
    const geo: Geo = (id: string) => byId.get(id);
    let hitLabelDim: Dimension | null = null;
    let hitDim: Dimension | null = null;
    let dimDist = Infinity;

    for (const dim of ctx.doc.dimensions) {
      const layout = dimensionLayout(dim, geo, ctx.doc.displayUnit);
      if (!layout) continue;
      const labelScreenDist = dist(e.screen, ctx.view.worldToScreen(layout.textPos));
      if (labelScreenDist < 12 && !hitLabelDim) hitLabelDim = dim;
      const d = dimensionHitDistance(dim, geo, e.worldRaw, ctx.doc.displayUnit) * ctx.view.scale;
      if (d < 15 && d < dimDist) { hitDim = dim; dimDist = d; }
    }

    if (hitLabelDim) {
      ctx.doc.selectedDimensionId = hitLabelDim.id;
      ctx.doc.emitChange();
      ctx.pushHistory();
      this.dragDimLabelId = hitLabelDim.id;
      this.mode = "maybeDragDimLabel";
      return;
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
      this.pickedEntId = hitEntId;
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
      if (ctx.currentDof() <= 0) { this.mode = "idle"; return; }
      ctx.pushHistory();
      this.dragSnapshot = ctx.doc.snapshot();
      this.mode = "dragPoint";
    } else if (this.mode === "maybeDragEntity" && dist(e.screen, this.downScreen) > DRAG_THRESHOLD_PX) {
      if (ctx.currentDof() <= 0) { this.mode = "idle"; return; }
      ctx.pushHistory();
      this.mode = "dragEntity";
      this.dragSnapshot = ctx.doc.snapshot();
      this.originalBounds = selectionBounds(ctx.doc.selected);
    } else if (this.mode === "maybeDragDimLabel" && dist(e.screen, this.downScreen) > DRAG_THRESHOLD_PX) {
      this.mode = "dragDimLabel";
    }

    if (this.mode === "dragDimLabel" && this.dragDimLabelId) {
      const dim = ctx.doc.dimensions.find(d => d.id === this.dragDimLabelId);
      if (dim) {
        const byId = new Map(ctx.doc.entities.map(en => [en.id, en]));
        const geo: Geo = id => byId.get(id);
        dim.offset = dimensionOffsetFromCursor(dim, geo, e.worldRaw);
        ctx.requestRender();
      }
      return;
    }

    if (this.mode === "dragPoint" && this.dragPoint && this.dragSnapshot) {
      if (e.shiftKey) {
        ctx.doc.restore(this.dragSnapshot);
        const ent = ctx.doc.entities.find(x => x.id === this.dragPoint!.entityId);
        if (ent) {
          const origPos = ent.getPoint(this.dragPoint!.key);
          const d = sub(e.world, origPos);
          for (const se of ctx.doc.selected) {
            if (!isEntityFixed(ctx.doc, se.id)) se.translate(d);
          }

          if (e.snap && e.snap.entityId !== ent.id) {
            const targetEnt = ctx.doc.entities.find(x => x.id === e.snap!.entityId);
            if (ent.type === "line" && targetEnt?.type === "line") {
              const lineOrig = ent as LineEntity;
              const lineTarget = targetEnt as LineEntity;
              if ((this.dragPoint!.key === "a" || this.dragPoint!.key === "b") && 
                  (e.snap.key === "a" || e.snap.key === "b" || e.snap.kind === "endpoint")) {
                
                const dragDir = this.dragPoint!.key === "a" ? sub(lineOrig.b, lineOrig.a) : sub(lineOrig.a, lineOrig.b);
                const targetKey = e.snap.key || (dist(e.snap.pos, lineTarget.a) < dist(e.snap.pos, lineTarget.b) ? "a" : "b");
                const targetDir = targetKey === "a" ? sub(lineTarget.b, lineTarget.a) : sub(lineTarget.a, lineTarget.b);

                const startAngle = Math.atan2(dragDir.y, dragDir.x);
                const targetAngle = Math.atan2(targetDir.y, targetDir.x) + Math.PI; // point away
                
                const unfixedSelected = ctx.doc.selected.filter(x => !isEntityFixed(ctx.doc, x.id));
                applyRotate(unfixedSelected, e.world.x, e.world.y, targetAngle - startAngle, (oldE, newE) => {
                  const idx = ctx.doc.entities.findIndex(x => x.id === oldE.id);
                  if (idx >= 0) ctx.doc.entities[idx] = newE;
                });
              }
            }
          }
          ctx.solve(pinsForSelected(ctx.doc));
        }
      } else {
        const pins: PinMap = new Map([[pointRefKey(this.dragPoint), e.world]]);
        ctx.solve(pins);
      }
    } else if (this.mode === "dragEntity" && this.dragSnapshot && this.originalBounds) {
      ctx.doc.restore(this.dragSnapshot);
      if (e.altKey) {
        const ob = this.originalBounds;
        const cx = (ob.min.x + ob.max.x) / 2;
        const cy = (ob.min.y + ob.max.y) / 2;
        
        const startAngle = Math.atan2(this.dragStartWorld.y - cy, this.dragStartWorld.x - cx);
        const currentAngle = Math.atan2(e.worldRaw.y - cy, e.worldRaw.x - cx);
        const angle = currentAngle - startAngle;
        
        const unfixedSelected = ctx.doc.selected.filter(x => !isEntityFixed(ctx.doc, x.id));
        applyRotate(unfixedSelected, cx, cy, angle, (oldE, newE) => {
          const idx = ctx.doc.entities.findIndex(x => x.id === oldE.id);
          if (idx >= 0) ctx.doc.entities[idx] = newE;
        });
        ctx.solve();
      } else {
        const d = sub(e.worldRaw, this.dragStartWorld);
        if (d.x !== 0 || d.y !== 0) {
          for (const ent of ctx.doc.selected) {
            if (!isEntityFixed(ctx.doc, ent.id)) ent.translate(d);
          }
          ctx.solve(pinsForSelected(ctx.doc));
        }
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
        const unfixedSelected = ctx.doc.selected.filter(x => !isEntityFixed(ctx.doc, x.id));
        applyScale(unfixedSelected, cx, cy, sx, sy);
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
      
      const unfixedSelected = ctx.doc.selected.filter(x => !isEntityFixed(ctx.doc, x.id));
      applyRotate(unfixedSelected, cx, cy, angle, (oldE, newE) => {
        const idx = ctx.doc.entities.findIndex(x => x.id === oldE.id);
        if (idx >= 0) ctx.doc.entities[idx] = newE;
      });
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

    // Double-click on TextEntity → open inline editor
    const hitEnt = ctx.doc.entities.find(x => x.id === hitEntId);
    if (hitEnt instanceof TextEntity) {
      openTextDialog(
        { text: hitEnt.text, fontId: hitEnt.fontId, sizeMM: hitEnt.sizeMM, angle: hitEnt.angle },
        "Apply",
        p => {
          ctx.pushHistory();
          hitEnt.text   = p.text;
          hitEnt.fontId = p.fontId;
          hitEnt.sizeMM = p.sizeMM;
          hitEnt.angle  = p.angle;
          ctx.doc.emitChange();
        },
      );
      return;
    }

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

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.mode === "marquee") {
      this.applyMarquee(ctx);
    } else if (this.mode === "maybeDragPoint" && this.dragPoint) {
      // Tap on a DOF point (no drag) — toggle it in selectedPoints for constraint wiring.
      ctx.doc.togglePoint(this.dragPoint);
    } else if (this.mode === "maybeDragEntity" && this.pickedEntId) {
      if (!e.shiftKey) {
        ctx.doc.clearSelection();
        const ent = ctx.doc.entities.find(x => x.id === this.pickedEntId);
        if (ent) {
          ent.selected = true;
          const group = ctx.doc.groupOf(ent.id);
          if (group) {
            for (const id of group.entityIds) {
              const ge = ctx.doc.entities.find(x => x.id === id);
              if (ge) ge.selected = true;
            }
          }
        }
        ctx.doc.emitChange();
      }
    } else if (this.mode === "dragScale" || this.mode === "dragRotate") {
      ctx.doc.emitChange(); // Ensure properties panel updates at end of drag
    }
    
    this.mode = "idle";
    this.dragPoint = null;
    this.dragSnapshot = null;
    this.originalBounds = null;
    this.activeHandleId = null;
    this.dragDimLabelId = null;
    this.pickedEntId = null;
    ctx.requestRender();
  }

  getOverlay(ctx?: ToolContext): ToolOverlay {
    if (this.mode === "marquee") {
      const crossing = this.marqueeEnd.x < this.marqueeStart.x;
      return { previews: [], selectionRect: { a: this.marqueeStart, b: this.marqueeEnd, crossing } };
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
    this.dragDimLabelId = null;
    ctx.requestRender();
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    const hasSelection = ctx.doc.selected.length > 0 || ctx.doc.selectedPoints.length > 0;
    if (!hasSelection) return;
    const type = CONSTRAINT_KEYS[e.key.toLowerCase()];
    if (!type) return;
    // Consume the key so app.ts doesn't switch tools (e.g. v→select, p→polyline, c→circle).
    e.preventDefault();
    const result = buildConstraintsFor(type, ctx.doc);
    if (!result.ok) return;
    ctx.pushHistory();
    for (const c of result.constraints) ctx.doc.addConstraint(c);
    ctx.doc.clearSelection();
    ctx.solve();
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
      { id: "rot", type: "rotate", stem: true, pos: { x: cx, y: max.y + ctx.view.toWorldLen(24) } } 
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

export function pickConstraintAt(doc: CADDocument, view: Viewport, screen: Vec2): Constraint | null {
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const geo = (id: string) => byId.get(id);
  const stack = new Map<string, number>();

  for (const c of doc.constraints) {
    const anchors = constraintAnchors(c, geo);
    for (const anchor of anchors) {
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
  }
  return null;
}
