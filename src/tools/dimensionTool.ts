/**
 * Dimension tool.
 *   - click point A, click point B, move to place, click → linear dimension.
 *     The sub-type is chosen by where you place it (drag up/down = horizontal,
 *     sideways = vertical, diagonal = aligned) — like SolidWorks "smart" dims.
 *   - click a circle, move to place, click → radius dimension (Tab toggles ⌀).
 * New dimensions are driving; double-click one (any tool) to edit its value.
 */

import { Vec2, dist, mid, normalize, sub, cross, dot } from "../core/vec2";
import { distToSegment } from "../core/geom";
import { Unit } from "../core/units";
import { Entity, LineEntity, RectEntity } from "../model/entities";
import { CADDocument } from "../model/document";
import { Geo, PointRef } from "../model/constraints";
import {
  Dimension,
  DimensionType,
  makeDimension,
  dimensionLayout,
  dimensionMeasure,
  dimensionOffsetFromCursor,
  chooseLinearType,
} from "../model/dimensions";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";

type Phase = "first" | "second" | "placeLinear" | "placeCircle" | "secondLine" | "placeAngle";
const POINT_PICK_PX = 8;

interface Pick {
  ref: PointRef;
  pos: Vec2;
}

export class DimensionTool implements Tool {
  readonly id = "dimension";
  readonly label = "Dimension (D)";
  readonly icon = ICONS.dimension;

  private phase: Phase = "first";
  private p1: Pick | null = null;
  private p2: Pick | null = null;
  private circleId: string | null = null;
  private circleKind: DimensionType = "radius";
  private line1Id: string | null = null;
  private line2Id: string | null = null;
  private firstMid: Pick | null = null;
  private hoverP1: Pick | null = null;
  private hoverP2: Pick | null = null;
  private firstRaw: Vec2 | null = null;
  private secondRaw: Vec2 | null = null;
  private hoverRaw: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private dragDim: Dimension | null = null;

  // committed-on-move placement state
  private curType: DimensionType = "distance";
  private curOffset = 0;
  private preview: ToolOverlay = { previews: [], selectionRect: null };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const tol = ctx.view.toWorldLen(POINT_PICK_PX);

    switch (this.phase) {
      case "first": {
        // Grab an existing dimension to reposition it (offset only — no re-solve).
        const existing = ctx.doc.dimensionAt(e.worldRaw, ctx.view.toWorldLen(8));
        if (existing) {
          ctx.pushHistory();
          this.dragDim = existing;
          return;
        }
        // Pick a DOF point (line endpoints, circle center, rect bl/tr corners),
        // falling back to the two virtual rect corners (br, tl) not in dofPoints.
        const pick =
          ctx.doc.pickPoint(e.worldRaw, tol) ??
          pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
        if (pick) {
          this.p1 = pick;
          this.phase = "second";
          break;
        }
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit && (hit.type === "circle" || hit.type === "arc")) {
          this.circleId = hit.id;
          this.circleKind = "radius";
          this.phase = "placeCircle";
        } else if (hit && hit.type === "rectangle") {
          // Clicking an edge directly sets both endpoints and skips the second pick.
          const edge = pickRectEdge(hit as RectEntity, e.worldRaw);
          if (edge) {
            this.firstRaw = e.worldRaw;
            this.firstMid = edge.mid;
            this.p1 = edge.p1;
            this.p2 = edge.p2;
            this.phase = "placeLinear";
          }
        } else if (hit) {
          if (hit.type === "line") {
            // Line body click: dimension the line length directly.
            const line = hit as LineEntity;
            this.firstRaw = e.worldRaw;
            this.firstMid = { ref: { entityId: hit.id, key: "mid" }, pos: mid(line.a, line.b) };
            this.p1 = { ref: { entityId: hit.id, key: "a" }, pos: { ...line.a } };
            this.p2 = { ref: { entityId: hit.id, key: "b" }, pos: { ...line.b } };
            this.phase = "placeLinear";
          } else {
            // Polyline body click: snap to nearest vertex.
            const entityPick = pickNearestEntityPoint(hit, e.worldRaw);
            if (entityPick) {
              this.p1 = entityPick;
              this.phase = "second";
            }
          }
        }
        break;
      }
      case "secondLine": {
        const hit2 = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit2 && hit2.type === "line" && hit2.id !== this.line1Id) {
          this.line2Id = hit2.id;
          this.phase = "placeAngle";
        }
        break;
      }
      case "second": {
        const pick =
          ctx.doc.pickPoint(e.worldRaw, tol) ??
          pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
        if (pick && !samePos(pick.pos, this.p1!.pos)) {
          this.p2 = pick;
          this.phase = "placeLinear";
          break;
        }
        // Entity body click: snap to nearest point on the hit entity.
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          const entityPick = pickNearestEntityPoint(hit, e.worldRaw);
          if (entityPick && !samePos(entityPick.pos, this.p1!.pos)) {
            this.p2 = entityPick;
            this.phase = "placeLinear";
          }
        }
        break;
      }
      case "placeLinear": {
        const pick =
          ctx.doc.pickPoint(e.worldRaw, tol) ??
          pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
        if (pick && !samePos(pick.pos, this.p1!.pos) && !samePos(pick.pos, this.p2!.pos)) {
          this.p2 = pick;
          this.hoverP2 = null;
          break;
        }
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          let newP1: Pick | null = null;
          let newP2: Pick | null = null;
          if (hit.type === "rectangle") {
            const edge = pickRectEdge(hit as RectEntity, e.worldRaw);
            if (edge && hit.id !== this.p1!.ref.entityId) {
              newP2 = edge.mid;
              if (this.firstMid) newP1 = this.firstMid;
            }
          } else if (hit.type === "line") {
            const line = hit as LineEntity;
            if (hit.id !== this.p1!.ref.entityId) {
              newP2 = { ref: { entityId: hit.id, key: "mid" }, pos: mid(line.a, line.b) };
              if (this.firstMid) newP1 = this.firstMid;
            }
          } else {
            const pt = pickNearestEntityPoint(hit, e.worldRaw);
            if (pt && !samePos(pt.pos, this.p1!.pos) && !samePos(pt.pos, this.p2!.pos)) {
              newP2 = pt;
              if (this.firstMid) newP1 = this.firstMid;
            }
          }
          if (newP2) {
            if (newP1 && newP1.ref.key.startsWith("mid") && newP2.ref.key.startsWith("mid")) {
              const edge1 = getEdgeEnds(ctx.doc, newP1);
              const edge2 = getEdgeEnds(ctx.doc, newP2);
              if (edge1 && edge2) {
                const dir1 = normalize(sub(edge1.b, edge1.a));
                const dir2 = normalize(sub(edge2.b, edge2.a));
                if (Math.abs(cross(dir1, dir2)) > 0.05) {
                  this.line1Id = newP1.ref.entityId;
                  this.line2Id = newP2.ref.entityId;
                  this.phase = "placeAngle";
                  this.hoverP1 = null;
                  this.hoverP2 = null;
                  break;
                }
              }
            }
            if (newP1) this.p1 = newP1;
            this.p2 = newP2;
            if (this.hoverRaw) this.secondRaw = this.hoverRaw;
            this.hoverP1 = null;
            this.hoverP2 = null;
            break;
          }
        }
        this.commitLinear(ctx);
        break;
      }
      case "placeCircle":
        this.commitCircle(ctx);
        break;
      case "placeAngle":
        this.commitAngle(ctx);
        break;
    }
    this.recompute(ctx);
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.dragDim) {
      const geo = geoOf(ctx.doc.entities);
      this.dragDim.offset = dimensionOffsetFromCursor(this.dragDim, geo, e.world);
      ctx.doc.emitChange();
      return;
    }
    
    if (this.phase === "placeLinear") {
      this.hoverP1 = null;
      this.hoverP2 = null;
      const tol = ctx.view.toWorldLen(POINT_PICK_PX);
      const pick =
        ctx.doc.pickPoint(e.worldRaw, tol) ??
        pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
      if (pick && !samePos(pick.pos, this.p1!.pos) && !samePos(pick.pos, this.p2!.pos)) {
        this.hoverP2 = pick;
      } else {
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          let newP1: Pick | null = null;
          let newP2: Pick | null = null;
          if (hit.type === "rectangle") {
            const edge = pickRectEdge(hit as RectEntity, e.worldRaw);
            if (edge && hit.id !== this.p1!.ref.entityId) {
              newP2 = edge.mid;
              if (this.firstMid) newP1 = this.firstMid;
              this.hoverRaw = e.worldRaw;
            }
          } else if (hit.type === "line") {
            const line = hit as LineEntity;
            if (hit.id !== this.p1!.ref.entityId) {
              newP2 = { ref: { entityId: hit.id, key: "mid" }, pos: mid(line.a, line.b) };
              if (this.firstMid) newP1 = this.firstMid;
              this.hoverRaw = e.worldRaw;
            }
          } else {
            const pt = pickNearestEntityPoint(hit, e.worldRaw);
            if (pt && !samePos(pt.pos, this.p1!.pos) && !samePos(pt.pos, this.p2!.pos)) {
              newP2 = pt;
              if (this.firstMid) newP1 = this.firstMid;
            }
          }
          if (newP2) {
            this.hoverP1 = newP1;
            this.hoverP2 = newP2;
          }
        }
      }
    }

    this.recompute(ctx);
    if (this.phase !== "first") ctx.requestRender();
  }

  onPointerUp(): void {
    this.dragDim = null;
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") {
      this.cancel(ctx);
    } else if (e.key === "Tab" && this.phase === "placeCircle") {
      const ent = this.circleId ? ctx.doc.entities.find(e => e.id === this.circleId) : null;
      if (ent?.type === "arc") {
        // arc: cycle radius → diameter → arclength → radius
        this.circleKind = this.circleKind === "radius" ? "diameter"
          : this.circleKind === "diameter" ? "arclength" : "radius";
      } else {
        this.circleKind = this.circleKind === "radius" ? "diameter" : "radius";
      }
      e.preventDefault();
      this.recompute(ctx);
      ctx.requestRender();
    }
  }

  getOverlay(): ToolOverlay {
    return this.preview;
  }

  cancel(ctx: ToolContext): void {
    this.phase = "first";
    this.p1 = null;
    this.p2 = null;
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.secondRaw = null;
    this.hoverRaw = null;
    this.circleId = null;
    this.line1Id = null;
    this.line2Id = null;
    this.preview = { previews: [], selectionRect: null };
    ctx.requestRender();
  }

  // --- placement -----------------------------------------------------------
  private recompute(ctx: ToolContext): void {
    const geo = geoOf(ctx.doc.entities);
    const unit = ctx.doc.displayUnit;
    this.preview = { previews: [], selectionRect: null };

    if (this.phase === "second" && this.p1) {
      this.preview.previews = [
        { kind: "line", a: this.p1.pos, b: this.cursor },
        { kind: "point", pos: this.p1.pos },
      ];
    } else if (this.phase === "placeLinear" && this.p1 && this.p2) {
      const activeP1 = this.hoverP1 ?? this.p1;
      const activeP2 = this.hoverP2 ?? this.p2;
      
      this.curType = chooseLinearType(activeP1.pos, activeP2.pos, this.cursor);
      if (activeP1.ref.key.startsWith("mid") && activeP2.ref.key.startsWith("mid")) {
        const edge1 = getEdgeEnds(ctx.doc, activeP1);
        const edge2 = getEdgeEnds(ctx.doc, activeP2);
        if (edge1 && edge2) {
          const dir1 = normalize(sub(edge1.b, edge1.a));
          const dir2 = normalize(sub(edge2.b, edge2.a));
          if (Math.abs(cross(dir1, dir2)) < 0.05) this.curType = "line-distance";
        }
      }
      
      const dim = this.linearDim(ctx, 0, activeP1, activeP2);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    } else if (this.phase === "placeCircle" && this.circleId) {
      const dim = this.circleDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    } else if (this.phase === "placeAngle" && this.line1Id && this.line2Id) {
      const dim = this.angleDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    }
  }

  private previewFromLayout(dim: Dimension, geo: Geo, unit: Unit): void {
    const layout = dimensionLayout(dim, geo, unit);
    if (!layout) return;
    const previews: PreviewShape[] = [
      ...layout.segments.map(([a, b]) => ({ kind: "line" as const, a, b })),
      { kind: "point" as const, pos: layout.textPos },
    ];
    if (layout.arc) {
      const { center, radius, startDir, endDir, ccw } = layout.arc;
      previews.push({ kind: "polyline" as const, points: arcPolylinePoints(center, radius, startDir, endDir, ccw), closed: false });
    }
    this.preview.previews = previews;
  }

  private angleDim(offset: number): Dimension {
    return makeDimension("angle", {
      entities: [this.line1Id!, this.line2Id!],
      value: 0,
      offset,
    });
  }

  private commitAngle(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.angleDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.line1Id = null;
    this.line2Id = null;
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.secondRaw = null;
    this.hoverRaw = null;
    this.finaliseDim(dim, ctx);
  }

  /**
   * Add a dimension to the doc. If adding it as driving would over-constrain
   * (DOF is already 0), demote it to a reference dimension instead and skip
   * the editor. Otherwise add driving and open the editor.
   */
  private finaliseDim(dim: Dimension, ctx: ToolContext): void {
    if (ctx.currentDof() < 1) {
      // Sketch is fully or already over-constrained — add as reference only.
      dim.driving = false;
    }
    ctx.doc.addDimension(dim);
    ctx.solve();
    if (dim.driving) ctx.openDimEditor(dim);
  }

  private linearDim(ctx: ToolContext, offset: number, activeP1?: Pick, activeP2?: Pick): Dimension {
    if (this.curType === "line-distance") {
      const ap1 = activeP1 ?? this.p1!;
      const ap2 = activeP2 ?? this.p2!;
      const p1Raw = this.firstRaw ?? ap1.pos;
      const p2Raw = (this.hoverP2 ? this.hoverRaw : this.secondRaw) ?? ap2.pos;
      
      const edge1 = getEdgeEnds(ctx.doc, ap1);
      const edge2 = getEdgeEnds(ctx.doc, ap2);
      
      return makeDimension(this.curType, {
        entities: [ap1.ref.entityId, ap2.ref.entityId],
        anchors: edge1 && edge2 ? [computeT(p1Raw, edge1.a, edge1.b), computeT(p2Raw, edge2.a, edge2.b)] : [0.5, 0.5],
        value: 0,
        offset,
      });
    }

    return makeDimension(this.curType, {
      points: [(activeP1 ?? this.p1!).ref, (activeP2 ?? this.p2!).ref],
      value: 0,
      offset,
    });
  }
  private circleDim(offset: number): Dimension {
    return makeDimension(this.circleKind, {
      entities: [this.circleId!],
      value: 0,
      offset,
    });
  }

  private commitLinear(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.linearDim(ctx, this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.p1 = null;
    this.p2 = null;
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.secondRaw = null;
    this.hoverRaw = null;
    this.finaliseDim(dim, ctx);
  }
  private commitCircle(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.circleDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.circleId = null;
    this.finaliseDim(dim, ctx);
  }
}

function geoOf(entities: Entity[]): Geo {
  const m = new Map(entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
}

function arcPolylinePoints(center: Vec2, radius: number, startDir: Vec2, endDir: Vec2, ccw: boolean): Vec2[] {
  const a0 = Math.atan2(startDir.y, startDir.x);
  const a1 = Math.atan2(endDir.y, endDir.x);
  let delta = a1 - a0;
  if (ccw && delta < 0) delta += 2 * Math.PI;
  if (!ccw && delta > 0) delta -= 2 * Math.PI;
  const N = Math.max(8, Math.ceil(Math.abs(delta) * 8));
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const a = a0 + delta * (i / N);
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}
function samePos(a: Vec2, b: Vec2): boolean {
  return dist(a, b) < 1e-9;
}

/** Nearest point on an entity for use as a dimension anchor (pickable points). */
function pickNearestEntityPoint(ent: Entity, p: Vec2): Pick | null {
  let best: Pick | null = null;
  let bestD = Infinity;
  for (const dp of ent.pickablePoints()) {
    const d = dist(dp.pos, p);
    if (d < bestD) {
      bestD = d;
      best = { ref: { entityId: ent.id, key: dp.key }, pos: dp.pos };
    }
  }
  return best;
}

/** Pick the br or tl corner of any rectangle — these aren't DOF points so pickPoint misses them. */
function pickVirtualRectCorner(entities: Entity[], p: Vec2, tol: number): Pick | null {
  let best: Pick | null = null;
  let bestD = tol;
  for (const ent of entities) {
    if (ent.type !== "rectangle") continue;
    const r = ent as RectEntity;
    for (const key of ["br", "tl"] as const) {
      const pos = r.getPoint(key);
      const d = dist(pos, p);
      if (d < bestD) {
        bestD = d;
        best = { ref: { entityId: r.id, key }, pos };
      }
    }
  }
  return best;
}

function getEdgeEnds(doc: CADDocument, midRef: Pick): { a: Vec2, b: Vec2 } | null {
  const e = doc.entities.find((x: Entity) => x.id === midRef.ref.entityId);
  if (!e) return null;
  if (e.type === "line") {
    return { a: (e as LineEntity).a, b: (e as LineEntity).b };
  } else if (e.type === "rectangle") {
    const key = midRef.ref.key;
    const r = e as RectEntity;
    if (key === "mid_b") return { a: r.getPoint("bl"), b: r.getPoint("br") };
    if (key === "mid_r") return { a: r.getPoint("br"), b: r.getPoint("tr") };
    if (key === "mid_t") return { a: r.getPoint("tr"), b: r.getPoint("tl") };
    if (key === "mid_l") return { a: r.getPoint("tl"), b: r.getPoint("bl") };
  }
  return null;
}

function computeT(raw: Vec2, a: Vec2, b: Vec2): number {
  const v = sub(b, a);
  const l2 = v.x * v.x + v.y * v.y;
  if (l2 < 1e-9) return 0.5;
  const t = dot(sub(raw, a), v) / l2;
  return Math.max(0, Math.min(1, t)); // constrain between 0 and 1
}

/** Find the closest edge of a rectangle and return its two corner PointRefs and its midpoint. */
function pickRectEdge(rect: RectEntity, p: Vec2): { p1: Pick; p2: Pick; mid: Pick } | null {
  const bl = rect.getPoint("bl");
  const br = rect.getPoint("br");
  const tr = rect.getPoint("tr");
  const tl = rect.getPoint("tl");
  const edges: [string, Vec2, string, Vec2, string, Vec2][] = [
    ["bl", bl, "br", br, "mid_b", mid(bl, br)],
    ["br", br, "tr", tr, "mid_r", mid(br, tr)],
    ["tr", tr, "tl", tl, "mid_t", mid(tr, tl)],
    ["tl", tl, "bl", bl, "mid_l", mid(tl, bl)],
  ];
  let best: [string, Vec2, string, Vec2, string, Vec2] | null = null;
  let bestD = Infinity;
  for (const edge of edges) {
    const d = distToSegment(p, edge[1], edge[3]);
    if (d < bestD) {
      bestD = d;
      best = edge;
    }
  }
  if (!best) return null;
  return {
    p1: { ref: { entityId: rect.id, key: best[0] }, pos: best[1] },
    p2: { ref: { entityId: rect.id, key: best[2] }, pos: best[3] },
    mid: { ref: { entityId: rect.id, key: best[4] }, pos: best[5] },
  };
}
