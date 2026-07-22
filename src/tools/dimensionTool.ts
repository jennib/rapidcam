/**
 * Dimension tool.
 *   - click point A, click point B, move to place, click → linear dimension.
 *     The sub-type is chosen by where you place it (drag up/down = horizontal,
 *     sideways = vertical, diagonal = aligned) — like SolidWorks "smart" dims.
 *   - click a circle, move to place, click → radius dimension (Tab toggles ⌀).
 * New dimensions are driving; double-click one (any tool) to edit its value.
 */

import { angleInArc, distToSegment } from "../core/geom";
import type { Unit } from "../core/units";
import { cross, dist, dot, mid, normalize, sub, type Vec2 } from "../core/vec2";
import type { Geo, PointRef } from "../model/constraints";
import {
  chooseLinearType,
  type Dimension,
  type DimensionType,
  dimensionLayout,
  dimensionMeasure,
  dimensionOffsetFromCursor,
  type LinearDimType,
  makeDimension,
} from "../model/dimensions";
import type { CADDocument } from "../model/document";
import {
  ArcEntity,
  CircleEntity,
  type Entity,
  type LineEntity,
  type RectEntity,
  TextEntity,
  type RasterImageEntity,
} from "../model/entities";

/** True when an entity can carry a radius / gap dimension. */
function isCircular(e: Entity | null): e is Entity {
  return !!e && (e.type === "circle" || e.type === "arc");
}

/**
 * True when a linear dimension measures across a single TextEntity's own box —
 * both anchors resolve to the same text. Such a dim can't drive: a text's size
 * lives in its font, not the solver, so both points move together and the
 * residual gradient is zero. Callers create these as reference (non-driving)
 * dims so editing the value doesn't silently revert. Exported for testing.
 */
export function measuresSingleTextBox(dim: Dimension, geo: Geo): boolean {
  if (dim.points.length !== 2) return false;
  const [a, b] = dim.points;
  if (a.entityId !== b.entityId) return false;
  return geo(a.entityId) instanceof TextEntity;
}

import type { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";
import type { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";

export type Phase =
  | "first"
  | "second"
  | "placeLinear"
  | "placeCircle"
  | "secondLine"
  | "placeAngle";
const POINT_PICK_PX = 8;

/**
 * Phase-aware status-bar hint. The tool's static TOOL_HINTS entry only covers
 * the start; once the user has picked their points the guidance must change —
 * above all it has to say the dimension is placed by clicking in OPEN SPACE.
 * (Clicking near geometry re-picks the point instead of placing, which reads as
 * "nothing happened" — audit #4.) `null` means "restore the tool default".
 */
export function dimensionHint(phase: Phase): string | null {
  switch (phase) {
    case "second":
      return "Click the second point or edge — or Esc to cancel";
    case "secondLine":
      return "Click a second line to dimension the angle between them";
    case "placeLinear":
    case "placeCircle":
    case "placeAngle":
      return "Move to position, then click in open space to place the dimension";
    default:
      return null; // "first" → the tool's default hint
  }
}

interface Pick {
  ref: PointRef;
  pos: Vec2;
}

export class DimensionTool implements Tool {
  readonly id = "dimension";
  readonly label = "Dimension";
  readonly icon = ICONS.dimension;

  private phase: Phase = "first";
  private p1: Pick | null = null;
  private p2: Pick | null = null;
  private circleId: string | null = null;
  private circleKind: DimensionType = "radius";
  // When hovering a second circle/arc while placing a circle dim, switch to a
  // gap dimension between the two (e.g. inner/outer offset). null = radius/⌀.
  private gapTargetId: string | null = null;
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
  private forcedLinearType: LinearDimType | null = null;
  private curOffset = 0;
  private preview: ToolOverlay = { previews: [], selectionRect: null };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const tol = ctx.view.toWorldLen(POINT_PICK_PX);

    switch (this.phase) {
      case "first": {
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

        // Grab an existing dimension to reposition it (offset only — no re-solve).
        const existing = ctx.doc.dimensionAt(e.worldRaw, ctx.view.toWorldLen(8));
        if (existing) {
          ctx.pushHistory();
          this.dragDim = existing;
          return;
        }
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit && (hit.type === "circle" || hit.type === "arc")) {
          this.circleId = hit.id;
          this.circleKind = "radius";
          this.phase = "placeCircle";
        } else if (hit && (hit.type === "rectangle" || hit.type === "image")) {
          // Clicking an edge directly sets both endpoints and skips the second pick.
          const edge = pickRectOrImageEdge(hit as RectEntity | RasterImageEntity, e.worldRaw);
          if (edge) {
            this.firstRaw = e.worldRaw;
            this.firstMid = edge.mid;
            this.p1 = edge.p1;
            this.p2 = edge.p2;
            const dx = Math.abs(edge.p2.pos.x - edge.p1.pos.x);
            const dy = Math.abs(edge.p2.pos.y - edge.p1.pos.y);
            this.forcedLinearType =
              dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
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
            // Lock to the line's actual orientation so the cursor position can't
            // accidentally produce a "distance" type (rotationally invariant).
            const dx = Math.abs(line.b.x - line.a.x);
            const dy = Math.abs(line.b.y - line.a.y);
            this.forcedLinearType =
              dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
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
          if (hit.type === "rectangle" || hit.type === "image") {
            const edge = pickRectOrImageEdge(hit as RectEntity | RasterImageEntity, e.worldRaw);
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
            if (newP1?.ref.key.startsWith("mid") && newP2.ref.key.startsWith("mid")) {
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
        if (this.gapTargetId) this.commitGap(ctx);
        else this.commitCircle(ctx);
        break;
      case "placeAngle":
        this.commitAngle(ctx);
        break;
    }
    this.recompute(ctx);
    this.updateHint(ctx);
    ctx.requestRender();
  }

  /** Push the hint for the current phase (see {@link dimensionHint}). */
  private updateHint(ctx: ToolContext): void {
    ctx.setHint(dimensionHint(this.phase));
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
          if (hit.type === "rectangle" || hit.type === "image") {
            const edge = pickRectOrImageEdge(hit as RectEntity | RasterImageEntity, e.worldRaw);
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

    if (this.phase === "placeCircle") {
      // Hovering a different circle/arc → preview a gap dim between the two.
      const tol = ctx.view.toWorldLen(POINT_PICK_PX);
      const hit = ctx.doc.hitTest(e.worldRaw, tol);
      this.gapTargetId = isCircular(hit) && hit.id !== this.circleId ? hit.id : null;
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
      const ent = this.circleId ? ctx.doc.entities.find((e) => e.id === this.circleId) : null;
      if (ent?.type === "arc") {
        // arc: cycle radius → diameter → arclength → radius
        this.circleKind =
          this.circleKind === "radius"
            ? "diameter"
            : this.circleKind === "diameter"
              ? "arclength"
              : "radius";
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
    this.gapTargetId = null;
    this.line1Id = null;
    this.line2Id = null;
    this.forcedLinearType = null;
    this.preview = { previews: [], selectionRect: null };
    this.updateHint(ctx); // phase reset to "first" → restore the default hint
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

      this.curType =
        this.forcedLinearType ?? chooseLinearType(activeP1.pos, activeP2.pos, this.cursor);
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
      const dim = this.gapTargetId ? this.gapDim(0) : this.circleDim(0);
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
      previews.push({
        kind: "polyline" as const,
        points: arcPolylinePoints(center, radius, startDir, endDir, ccw),
        closed: false,
      });
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
    // Refresh the DOF FIRST: some draw tools (circle/arc/line) don't re-solve on
    // commit, so currentDof() can be stale from before the geometry existed —
    // typically the empty-doc 0. Reading that stale 0 here would wrongly demote
    // the FIRST dimension on freshly-drawn geometry to a non-driving reference:
    // no editor, no constraint, no feedback — which reads as "nothing happened"
    // (audit #4). Solving now makes the check reflect the geometry as it is.
    ctx.solve();
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
        anchors:
          edge1 && edge2
            ? [computeT(p1Raw, edge1.a, edge1.b), computeT(p2Raw, edge2.a, edge2.b)]
            : [0.5, 0.5],
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
  private gapDim(offset: number): Dimension {
    return makeDimension("circle-gap", {
      entities: [this.circleId!, this.gapTargetId!],
      value: 0,
      offset,
    });
  }

  private commitLinear(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.linearDim(ctx, this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    // A dim across a single text's own box can't drive (the size lives in the
    // font, not the solver — both anchors translate together). Make it a
    // reference dimension so editing its value doesn't silently revert.
    if (measuresSingleTextBox(dim, geo)) {
      dim.driving = false;
      ctx.notify("Reference dimension — text size is set by its font/size, not driven");
    }
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
    this.gapTargetId = null;
    this.finaliseDim(dim, ctx);
  }
  private commitGap(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.gapDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.circleId = null;
    this.gapTargetId = null;
    this.finaliseDim(dim, ctx);
  }
}

function geoOf(entities: Entity[]): Geo {
  const m = new Map(entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
}

function arcPolylinePoints(
  center: Vec2,
  radius: number,
  startDir: Vec2,
  endDir: Vec2,
  ccw: boolean,
): Vec2[] {
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

/** Circle/arc rim anchor at the clicked angle, or null when the click is nearer
 *  the centre (or off an arc's span). The key encodes the angle so the point is
 *  recomputed live from the circle as it resizes/moves. */
function circleEdgePick(ent: CircleEntity | ArcEntity, p: Vec2): Pick | null {
  const c = ent.center,
    r = ent.radius;
  const dCenter = dist(c, p);
  if (Math.abs(dCenter - r) >= dCenter) return null; // nearer the centre → let it win
  const theta = Math.atan2(p.y - c.y, p.x - c.x);
  if (ent instanceof ArcEntity && !angleInArc(theta, ent.startAngle, ent.endAngle)) return null;
  return {
    ref: { entityId: ent.id, key: `edge@${theta}` },
    pos: { x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) },
  };
}

/** Nearest point on an entity for use as a dimension anchor (pickable points). */
function pickNearestEntityPoint(ent: Entity, p: Vec2): Pick | null {
  if (ent instanceof CircleEntity || ent instanceof ArcEntity) {
    const edge = circleEdgePick(ent, p);
    if (edge) return edge;
  }
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

function getEdgeEnds(doc: CADDocument, midRef: Pick): { a: Vec2; b: Vec2 } | null {
  const e = doc.entities.find((x: Entity) => x.id === midRef.ref.entityId);
  if (!e) return null;
  if (e.type === "line") {
    return { a: (e as LineEntity).a, b: (e as LineEntity).b };
  } else if (e.type === "rectangle" || e.type === "image") {
    const key = midRef.ref.key;
    const isImg = e.type === "image";
    const blKey = isImg ? "c0" : "bl";
    const brKey = isImg ? "c1" : "br";
    const trKey = isImg ? "c2" : "tr";
    const tlKey = isImg ? "c3" : "tl";
    if (key === "mid_b") return { a: e.getPoint(blKey), b: e.getPoint(brKey) };
    if (key === "mid_r") return { a: e.getPoint(brKey), b: e.getPoint(trKey) };
    if (key === "mid_t") return { a: e.getPoint(trKey), b: e.getPoint(tlKey) };
    if (key === "mid_l") return { a: e.getPoint(tlKey), b: e.getPoint(blKey) };
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

/** Find the closest edge of a rectangle or image and return its two corner PointRefs and its midpoint. */
function pickRectOrImageEdge(ent: RectEntity | RasterImageEntity, p: Vec2): { p1: Pick; p2: Pick; mid: Pick } | null {
  const isImg = ent.type === "image";
  const blKey = isImg ? "c0" : "bl";
  const brKey = isImg ? "c1" : "br";
  const trKey = isImg ? "c2" : "tr";
  const tlKey = isImg ? "c3" : "tl";
  const bl = ent.getPoint(blKey);
  const br = ent.getPoint(brKey);
  const tr = ent.getPoint(trKey);
  const tl = ent.getPoint(tlKey);
  const edges: [string, Vec2, string, Vec2, string, Vec2][] = [
    [blKey, bl, brKey, br, "mid_b", mid(bl, br)],
    [brKey, br, trKey, tr, "mid_r", mid(br, tr)],
    [trKey, tr, tlKey, tl, "mid_t", mid(tr, tl)],
    [tlKey, tl, blKey, bl, "mid_l", mid(tl, bl)],
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
    p1: { ref: { entityId: ent.id, key: best[0] }, pos: best[1] },
    p2: { ref: { entityId: ent.id, key: best[2] }, pos: best[3] },
    mid: { ref: { entityId: ent.id, key: best[4] }, pos: best[5] },
  };
}
